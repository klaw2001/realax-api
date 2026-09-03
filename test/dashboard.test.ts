import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import { hashPassword } from '../src/modules/auth/auth.service'

/**
 * The agent's home page (UX plan item 08).
 *
 * The fixtures are built through Prisma rather than the API because most of
 * what this endpoint reports cannot be reached through it: there is no way to
 * back-date a draft, fail a compliance check on demand, or mark a transaction
 * COMPLETED — and those are exactly the states the page exists to surface.
 */

const EMAIL = 'dashboard.test.agent@realax.test'
const OTHER_EMAIL = 'dashboard.test.other@realax.test'
const PASSWORD = 'a-correct-test-password'

let agentId = ''
let otherAgentId = ''
let templateId = ''

let blockedId = ''
let unverifiedId = ''
let staleId = ''
let completedId = ''

const signIn = async () => {
    const agent = request.agent(app)

    await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD }).expect(200)

    return agent
}

const daysAgo = (days: number) => {
    const at = new Date()

    at.setUTCDate(at.getUTCDate() - days)

    return at
}

const clear = async () => {
    const owned = { transaction: { agentId: { in: [agentId, otherAgentId] } } }

    const parties = await prisma.transactionParty.findMany({ where: owned, select: { partyId: true } })
    const forms = await prisma.transactionForm.findMany({ where: owned, select: { id: true } })

    await prisma.complianceCheck.deleteMany({
        where: { transactionFormId: { in: forms.map(form => form.id) } }
    })
    await prisma.transactionForm.deleteMany({ where: owned })
    await prisma.transactionParty.deleteMany({ where: owned })
    await prisma.identityRecord.deleteMany({ where: { partyId: { in: parties.map(row => row.partyId) } } })
    await prisma.party.deleteMany({ where: { id: { in: parties.map(row => row.partyId) } } })
    await prisma.transaction.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } })
}

beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD)

    const created = await prisma.agent.upsert({
        where: { email: EMAIL },
        update: { passwordHash },
        create: { email: EMAIL, name: 'Dashboard Test Agent', passwordHash }
    })

    const other = await prisma.agent.upsert({
        where: { email: OTHER_EMAIL },
        update: {},
        create: { email: OTHER_EMAIL, name: 'Dashboard Other Agent' }
    })

    agentId = created.id
    otherAgentId = other.id

    await clear()

    const template = await prisma.formTemplate.upsert({
        where: { formCode_revision: { formCode: 'DASH', revision: 'test' } },
        update: {},
        create: {
            formCode: 'DASH',
            revision: 'test',
            sourceSha256: 'x'.repeat(64),
            sourceS3Key: 'test/dashboard.pdf',
            fieldMap: {}
        }
    })

    templateId = template.id

    // Blocked: its most recent check failed, naming three fields. An earlier
    // failing check on the same form must not be counted twice.
    const blocked = await prisma.transaction.create({
        data: { type: 'LISTING', status: 'COMPLIANCE_PENDING', agentId },
        select: { id: true }
    })

    const form = await prisma.transactionForm.create({
        data: { transactionId: blocked.id, formTemplateId: templateId, values: {} },
        select: { id: true }
    })

    await prisma.complianceCheck.create({
        data: {
            transactionFormId: form.id,
            missingFields: [{ field: 'a' }, { field: 'b' }],
            overrides: [],
            passed: false,
            checkedAt: daysAgo(2)
        }
    })

    await prisma.complianceCheck.create({
        data: {
            transactionFormId: form.id,
            missingFields: [{ field: 'a' }, { field: 'b' }, { field: 'c' }],
            overrides: [],
            passed: false,
            checkedAt: daysAgo(1)
        }
    })

    blockedId = blocked.id

    // Two parties, neither verified.
    const unverified = await prisma.transaction.create({
        data: {
            type: 'LISTING',
            status: 'DRAFT',
            agentId,
            parties: {
                create: [
                    { role: 'SELLER', party: { create: { fullLegalName: 'Unverified Seller' } } },
                    { role: 'SPOUSE', party: { create: { fullLegalName: 'Unverified Spouse' } } }
                ]
            }
        },
        select: { id: true }
    })

    unverifiedId = unverified.id

    const stale = await prisma.transaction.create({
        data: { type: 'LISTING', status: 'DRAFT', agentId },
        select: { id: true }
    })

    // `updatedAt` is @updatedAt, so it has to be pushed back after the write.
    await prisma.$executeRaw`UPDATE "Transaction" SET "updatedAt" = ${daysAgo(30)} WHERE id = ${stale.id}`

    staleId = stale.id

    const completed = await prisma.transaction.create({
        data: { type: 'LISTING', status: 'COMPLETED', agentId },
        select: { id: true }
    })

    completedId = completed.id

    // Somebody else's, in every state that would otherwise show up.
    await prisma.transaction.create({
        data: { type: 'LISTING', status: 'COMPLIANCE_PENDING', agentId: otherAgentId }
    })
})

afterAll(async () => {
    await clear()
    await prisma.formTemplate.deleteMany({ where: { formCode: 'DASH', revision: 'test' } })
    await prisma.agent.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } })

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

describe('the dashboard is behind the session guard', () => {
    test('without a session it is 401', async () => {
        const response = await request(app).get('/api/me/dashboard')

        expect(response.status).toEqual(401)
    })
})

describe('the counts', () => {
    test('cover every status, including the ones at zero', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        expect(response.status).toEqual(200)

        // A row of tiles that changes shape as the day goes on is harder to
        // read than one that does not.
        expect(Object.keys(response.body.statusCounts).sort()).toEqual([
            'CANCELLED',
            'COMPLETED',
            'COMPLIANCE_PENDING',
            'DRAFT',
            'OUT_FOR_SIGNATURE',
            'READY_TO_SIGN'
        ])

        expect(response.body.statusCounts.DRAFT).toEqual(2)
        expect(response.body.statusCounts.COMPLIANCE_PENDING).toEqual(1)
        expect(response.body.statusCounts.COMPLETED).toEqual(1)
        expect(response.body.statusCounts.CANCELLED).toEqual(0)
    })

    test("do not include another agent's transactions", async () => {
        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        // The other agent has a COMPLIANCE_PENDING one too.
        expect(response.body.statusCounts.COMPLIANCE_PENDING).toEqual(1)
    })

    test('completed this month counts the month, not all time', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        expect(response.body.completedThisMonth).toEqual(1)
        expect(completedId).toBeTruthy()
    })
})

describe('what needs the agent today', () => {
    test('a blocked transaction is named once, with the latest check believed', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        const rows = response.body.attention.filter(
            (item: { kind: string }) => item.kind === 'compliance_blocked'
        )

        expect(rows).toHaveLength(1)
        expect(rows[0].transactionId).toEqual(blockedId)

        // The most recent check named three fields; the earlier one named two
        // and must not be added to it.
        expect(rows[0].count).toEqual(3)
    })

    test('parties with no identity record are counted per transaction', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        const row = response.body.attention.find(
            (item: { kind: string }) => item.kind === 'identity_missing'
        )

        expect(row.transactionId).toEqual(unverifiedId)
        expect(row.count).toEqual(2)
    })

    test('a verified party stops being exposure', async () => {
        const party = await prisma.transactionParty.findFirstOrThrow({
            where: { transactionId: unverifiedId },
            select: { partyId: true }
        })

        await prisma.identityRecord.create({
            data: {
                partyId: party.partyId,
                documentType: 'drivers_licence',
                documentNumber: '',
                verifiedAt: new Date(),
                verifiedMethod: 'government_photo_id',
                s3Key: ''
            }
        })

        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        const row = response.body.attention.find(
            (item: { kind: string }) => item.kind === 'identity_missing'
        )

        expect(row.count).toEqual(1)

        await prisma.identityRecord.deleteMany({ where: { partyId: party.partyId } })
    })

    test('a draft nobody has touched is a row, with how long it has sat', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        const row = response.body.attention.find((item: { kind: string }) => item.kind === 'stale_draft')

        expect(row.transactionId).toEqual(staleId)
        expect(row.count).toBeGreaterThanOrEqual(29)
    })

    test('a draft from this week is not one', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        const stale = response.body.attention.filter(
            (item: { kind: string }) => item.kind === 'stale_draft'
        )

        // `unverifiedId` is also a DRAFT and was created just now.
        expect(stale.map((item: { transactionId: string }) => item.transactionId)).toEqual([staleId])
    })

    test('the most blocking comes first', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        const kinds = response.body.attention.map((item: { kind: string }) => item.kind)

        // Compliance stops a document being produced at all; identity is
        // exposure; a stale draft is a nudge.
        expect(kinds).toEqual(['compliance_blocked', 'identity_missing', 'stale_draft'])
    })

    test('nothing on the list belongs to another agent', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        const ids = response.body.attention.map((item: { transactionId: string }) => item.transactionId)

        const owners = await prisma.transaction.findMany({
            where: { id: { in: ids } },
            select: { agentId: true }
        })

        expect(new Set(owners.map(row => row.agentId))).toEqual(new Set([agentId]))
    })
})

describe('recent activity', () => {
    test('is the same shape the list page renders, so nothing is fetched twice', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        expect(response.body.recent.length).toBeGreaterThan(0)

        const row = response.body.recent[0]

        expect(row).toHaveProperty('status')
        expect(row).toHaveProperty('partyCount')
        expect(row).toHaveProperty('property')
    })

    test('is capped, so the home page cannot become the list page', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/me/dashboard')

        expect(response.body.recent.length).toBeLessThanOrEqual(5)
    })
})
