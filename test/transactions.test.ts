import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import { hashPassword } from '../src/modules/auth/auth.service'

// Two agents: one to act as, one to prove the list is scoped to the caller.
const EMAIL = 'transactions.test.agent@realax.test'
const OTHER_EMAIL = 'transactions.test.other@realax.test'
const PASSWORD = 'a-correct-test-password'

let agentId = ''
let otherAgentId = ''

const signIn = async () => {
    const agent = request.agent(app)

    const response = await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })

    expect(response.status).toEqual(200)

    return agent
}

beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD)

    const created = await prisma.agent.upsert({
        where: { email: EMAIL },
        update: { passwordHash },
        create: { email: EMAIL, name: 'Transactions Test Agent', passwordHash }
    })

    const other = await prisma.agent.upsert({
        where: { email: OTHER_EMAIL },
        update: {},
        create: { email: OTHER_EMAIL, name: 'Other Test Agent' }
    })

    agentId = created.id
    otherAgentId = other.id

    // Left over from a previous run, so counts in this suite are its own.
    await clearTransactions()
})

/**
 * Parties first, then the transactions they hang off.
 *
 * `TransactionParty` has a foreign key to `Transaction` and no cascade — a soft
 * delete is the only removal the application performs, so nothing in production
 * ever needs one. A suite that creates parties has to unwind them itself, and
 * the `Party` rows behind them, or the next run starts against rows it did not
 * make.
 */
const clearTransactions = async () => {
    const owned = { transaction: { agentId: { in: [agentId, otherAgentId] } } }

    const parties = await prisma.transactionParty.findMany({
        where: owned,
        select: { partyId: true }
    })

    await prisma.transactionParty.deleteMany({ where: owned })
    await prisma.party.deleteMany({ where: { id: { in: parties.map(row => row.partyId) } } })
    await prisma.transaction.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } })
}

afterAll(async () => {
    await clearTransactions()
    await prisma.property.deleteMany({ where: { mlsNumber: { in: ['C8123456', 'W9998888'] } } })
    await prisma.agent.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } })

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

describe('the transactions module is behind the session guard', () => {
    test('GET /api/transactions without a session is 401', async () => {
        const response = await request(app).get('/api/transactions')

        expect(response.status).toEqual(401)
    })

    test('POST /api/transactions without a session is 401', async () => {
        const response = await request(app).post('/api/transactions').send({ type: 'LISTING' })

        expect(response.status).toEqual(401)
    })
})

describe('POST /api/transactions', () => {
    test('selecting Listing creates a DRAFT owned by the caller', async () => {
        const agent = await signIn()

        const response = await agent.post('/api/transactions').send({ type: 'LISTING' })

        expect(response.status).toEqual(201)
        expect(response.body.transaction.type).toEqual('LISTING')
        expect(response.body.transaction.status).toEqual('DRAFT')
        expect(response.body.transaction.agentId).toEqual(agentId)

        // No property yet — that is build plan 1.4.
        expect(response.body.transaction.propertyId).toBeNull()

        const stored = await prisma.transaction.findUnique({
            where: { id: response.body.transaction.id }
        })

        expect(stored?.status).toEqual('DRAFT')
        expect(stored?.type).toEqual('LISTING')
    })

    test('the status is not taken from the request', async () => {
        const agent = await signIn()

        const response = await agent
            .post('/api/transactions')
            .send({ type: 'LISTING', status: 'COMPLETED' })

        expect(response.status).toEqual(201)
        expect(response.body.transaction.status).toEqual('DRAFT')
    })

    test('the owner is not taken from the request', async () => {
        const agent = await signIn()

        const response = await agent
            .post('/api/transactions')
            .send({ type: 'LISTING', agentId: otherAgentId })

        expect(response.status).toEqual(201)
        expect(response.body.transaction.agentId).toEqual(agentId)
    })

    test('Purchase is refused, and says why rather than reading as a bad request', async () => {
        const agent = await signIn()

        const response = await agent.post('/api/transactions').send({ type: 'PURCHASE' })

        expect(response.status).toEqual(400)
        expect(response.body.error).toEqual('transaction_type_unavailable')
        expect(response.body.message).toContain('not available yet')
    })

    test('Lease is refused the same way', async () => {
        const agent = await signIn()

        const response = await agent.post('/api/transactions').send({ type: 'LEASE' })

        expect(response.status).toEqual(400)
        expect(response.body.error).toEqual('transaction_type_unavailable')
    })

    test('a refused type creates nothing', async () => {
        const agent = await signIn()

        const before = await prisma.transaction.count({ where: { agentId } })

        await agent.post('/api/transactions').send({ type: 'LEASE' })

        expect(await prisma.transaction.count({ where: { agentId } })).toEqual(before)
    })

    test('a missing or unknown type is a plain validation failure', async () => {
        const agent = await signIn()

        const missing = await agent.post('/api/transactions').send({})

        expect(missing.status).toEqual(400)
        expect(missing.body.error).toEqual('invalid_request')

        const nonsense = await agent.post('/api/transactions').send({ type: 'SUBLET' })

        expect(nonsense.status).toEqual(400)
        expect(nonsense.body.error).toEqual('invalid_request')
    })
})

describe('GET /api/transactions', () => {
    test('returns the caller transactions, newest first', async () => {
        const agent = await signIn()

        const first = await agent.post('/api/transactions').send({ type: 'LISTING' })
        const second = await agent.post('/api/transactions').send({ type: 'LISTING' })

        const response = await agent.get('/api/transactions')

        expect(response.status).toEqual(200)

        const ids = response.body.transactions.map((transaction: { id: string }) => transaction.id)

        expect(ids).toContain(first.body.transaction.id)
        expect(ids).toContain(second.body.transaction.id)
        expect(ids.indexOf(second.body.transaction.id)).toBeLessThan(
            ids.indexOf(first.body.transaction.id)
        )
    })

    test("does not return another agent's transactions", async () => {
        await prisma.transaction.create({
            data: { type: 'LISTING', status: 'DRAFT', agentId: otherAgentId }
        })

        const agent = await signIn()

        const response = await agent.get('/api/transactions')

        const owners = response.body.transactions.map(
            (transaction: { agentId: string }) => transaction.agentId
        )

        expect(owners).not.toContain(otherAgentId)
        expect(new Set(owners)).toEqual(new Set([agentId]))
    })
})

/**
 * Filtering, ordering and paging the list (UX plan item 06).
 *
 * Server-side, so these are the tests that decide whether a filtered list is a
 * link that survives a reload. The fixtures are built through Prisma rather
 * than the API because the API cannot create a COMPLETED transaction or backdate
 * one, and those are exactly the cases the status and date filters exist for.
 */
describe('narrowing the list', () => {
    let mapleId = ''
    let oakId = ''
    let bareId = ''

    beforeAll(async () => {
        // Everything the earlier describes created, so the counts and the
        // orderings below are this block's own.
        await clearTransactions()
        await prisma.property.deleteMany({ where: { mlsNumber: { in: ['C8123456', 'W9998888'] } } })

        const maple = await prisma.property.create({
            data: { address: '18 Maple Grove Ave', city: 'Toronto', mlsNumber: 'C8123456' }
        })

        const oak = await prisma.property.create({
            data: { address: '4 Oak Street', city: 'Hamilton', mlsNumber: 'W9998888' }
        })

        const withParties = await prisma.transaction.create({
            data: {
                type: 'LISTING',
                status: 'COMPLIANCE_PENDING',
                agentId,
                propertyId: maple.id,
                createdAt: new Date('2026-08-10T12:00:00.000Z'),
                parties: {
                    create: [
                        { role: 'SELLER', party: { create: { fullLegalName: 'A Seller' } } },

                        // Removed, so it must not be counted.
                        {
                            role: 'SPOUSE',
                            deletedAt: new Date(),
                            party: { create: { fullLegalName: 'A Former Spouse' } }
                        }
                    ]
                }
            }
        })

        const completed = await prisma.transaction.create({
            data: {
                type: 'LISTING',
                status: 'COMPLETED',
                agentId,
                propertyId: oak.id,
                createdAt: new Date('2026-09-02T12:00:00.000Z')
            }
        })

        const bare = await prisma.transaction.create({
            data: {
                type: 'LISTING',
                status: 'DRAFT',
                agentId,
                createdAt: new Date('2026-09-03T12:00:00.000Z')
            }
        })

        mapleId = withParties.id
        oakId = completed.id
        bareId = bare.id
    })

    const ids = (body: { transactions: { id: string }[] }) => body.transactions.map(row => row.id)

    test('a row carries the address and the party count, so the table needs no second request', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/transactions')

        expect(response.status).toEqual(200)

        const row = response.body.transactions.find((item: { id: string }) => item.id === mapleId)

        expect(row.property.address).toEqual('18 Maple Grove Ave')
        expect(row.property.mlsNumber).toEqual('C8123456')

        // The removed spouse is not counted.
        expect(row.partyCount).toEqual(1)
    })

    test('a draft with no property yet is a null property, not a missing row', async () => {
        const agent = await signIn()
        const response = await agent.get('/api/transactions')

        const row = response.body.transactions.find((item: { id: string }) => item.id === bareId)

        expect(row.property).toBeNull()
        expect(row.partyCount).toEqual(0)
    })

    test('search matches the address, the city and the MLS number', async () => {
        const agent = await signIn()

        expect(ids((await agent.get('/api/transactions?search=maple')).body)).toEqual([mapleId])
        expect(ids((await agent.get('/api/transactions?search=hamilton')).body)).toEqual([oakId])
        expect(ids((await agent.get('/api/transactions?search=C81234')).body)).toEqual([mapleId])
    })

    test('search is case-insensitive, which is how anybody types an address', async () => {
        const agent = await signIn()

        expect(ids((await agent.get('/api/transactions?search=MAPLE%20GROVE')).body)).toEqual([mapleId])
    })

    test('status accepts several, and any of them matches', async () => {
        const agent = await signIn()

        const one = await agent.get('/api/transactions?status=COMPLETED')

        expect(ids(one.body)).toEqual([oakId])

        const two = await agent.get('/api/transactions?status=COMPLETED&status=DRAFT')

        expect(new Set(ids(two.body))).toEqual(new Set([oakId, bareId]))
    })

    test('the created range includes both of the days it names', async () => {
        const agent = await signIn()

        // The 2nd is the last day of the range and its transaction is at noon.
        // `lte` on the same midnight would have excluded it.
        const response = await agent.get('/api/transactions?createdFrom=2026-08-10&createdTo=2026-09-02')

        expect(new Set(ids(response.body))).toEqual(new Set([mapleId, oakId]))
    })

    test('filters combine rather than replace one another', async () => {
        const agent = await signIn()

        const response = await agent.get('/api/transactions?status=COMPLETED&search=maple')

        // Maple is COMPLIANCE_PENDING and Oak is COMPLETED, so together they
        // match nothing — the empty state has to be able to say "nothing
        // matches these filters" rather than "you have no transactions".
        expect(ids(response.body)).toEqual([])
        expect(response.body.total).toEqual(0)
    })

    test('the total counts what matched, not what fits on the page', async () => {
        const agent = await signIn()

        const response = await agent.get('/api/transactions?pageSize=1')

        expect(response.body.transactions).toHaveLength(1)
        expect(response.body.total).toEqual(3)
        expect(response.body.page).toEqual(1)
        expect(response.body.pageSize).toEqual(1)
    })

    test('paging walks the list without repeating or skipping a row', async () => {
        const agent = await signIn()

        const first = await agent.get('/api/transactions?pageSize=2&page=1')
        const second = await agent.get('/api/transactions?pageSize=2&page=2')

        expect(ids(first.body)).toHaveLength(2)
        expect(ids(second.body)).toHaveLength(1)
        expect(new Set([...ids(first.body), ...ids(second.body)])).toEqual(
            new Set([mapleId, oakId, bareId])
        )
    })

    test('ordering is newest first by default, and can be reversed', async () => {
        const agent = await signIn()

        expect(ids((await agent.get('/api/transactions')).body)).toEqual([bareId, oakId, mapleId])
        expect(ids((await agent.get('/api/transactions?direction=asc')).body)).toEqual([
            mapleId,
            oakId,
            bareId
        ])
    })

    test('a filter that is not valid is refused rather than quietly ignored', async () => {
        const agent = await signIn()

        // A list that returned everything because the status was misspelled is
        // the kind of wrong answer nobody notices until it matters.
        const response = await agent.get('/api/transactions?status=Draft')

        expect(response.status).toEqual(400)
        expect(response.body.error).toEqual('invalid_request')
        expect(response.body.message).toContain('status')

        expect((await agent.get('/api/transactions?pageSize=0')).status).toEqual(400)
        expect((await agent.get('/api/transactions?createdFrom=last-tuesday')).status).toEqual(400)
    })

    test('the filters cannot widen the list past the caller', async () => {
        await prisma.transaction.create({
            data: { type: 'LISTING', status: 'DRAFT', agentId: otherAgentId }
        })

        const agent = await signIn()

        // Every clause narrows within `agentId`, which is not something the
        // caller supplies.
        const response = await agent.get('/api/transactions?status=DRAFT&pageSize=100')

        expect(ids(response.body)).toEqual([bareId])
    })
})
