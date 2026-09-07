import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import s3, { headObject, keys } from '../src/lib/s3'
import { hashPassword } from '../src/modules/auth/auth.service'

// These tests talk to the real bucket in ca-central-1. Individual cases measure
// 2.5-5s, which sits right on Jest's 5-second default — so the suite passed
// alone and failed under the parallel load of a full run, which is the worst
// kind of failing test: one that is right about the code and wrong about the
// day. The latency is real and worth waiting for; an integration test that
// mocked S3 would confirm a bucket configuration it never checked.
jest.setTimeout(30_000)


// Build plan 2.3 and 2.4, at the boundary. The gate itself is unit-tested in
// compliance.test.ts; what this suite is about is that it is actually in front
// of the fill, and that a transaction which fails it produces no document at
// all — not a partial one, not one marked non-compliant.

const FORM = '100'

const EMAIL = 'forms.routes.test.agent@realax.test'
const OTHER_EMAIL = 'forms.routes.test.other@realax.test'
const PASSWORD = 'a-correct-test-password'

let agentId = ''
let otherAgentId = ''
let brokerageId = ''
let transactionId = ''
let otherTransactionId = ''

const signIn = async () => {
    const agent = request.agent(app)

    const response = await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })

    expect(response.status).toEqual(200)

    return agent
}

/** Everything the gate wants, so a test can take one thing away at a time. */
const completeEntries = {
    agreementDate: '2026-09-02',
    purchasePrice: '1225000.00',
    purchasePriceWords: 'One Million Two Hundred Twenty-Five Thousand',
    depositTiming: 'Upon Acceptance',
    depositAmount: '60000.00',
    depositAmountWords: 'Sixty Thousand',
    depositHolder: 'Realax Realty Inc., Brokerage',
    schedulesList: 'A',
    irrevocabilityBoundParty: 'Buyer',
    irrevocabilityTime: '11:59 p.m.',
    irrevocabilityDate: '2026-09-04',
    completionDate: '2026-11-14',
    titleSearchDate: '2026-10-24',
    noticesSellerFax: '416-555-0143',
    noticesBuyerFax: '416-555-0165',
    chattelsIncluded: ['Refrigerator', 'Stove'],
    fixturesExcluded: ['Dining room chandelier'],
    rentalItems: ['Hot water tank'],
    hstTreatment: 'included in',
    propertyPresentUse: 'Single family residential',
    listingBrokerageName: 'Bayview Heights Real Estate Ltd., Brokerage',
    listingBrokerageTel: '416-555-0173',
    listingBrokerageSalesperson: 'Alan Prakash',
    sellerLawyerName: 'Hollis & Wren LLP',
    sellerLawyerAddress: '120 Adelaide Street West, Suite 900, Toronto, ON M5H 1T1',
    sellerLawyerEmail: 'conveyancing@holliswren.example.test',
    sellerLawyerTel: '416-555-0107',
    sellerLawyerFax: '416-555-0108',
    buyerLawyerName: 'Marchetti Law Professional Corporation',
    buyerLawyerAddress: '75 Front Street East, Suite 300, Toronto, ON M5E 1B8',
    buyerLawyerEmail: 'closings@marchettilaw.example.test',
    buyerLawyerTel: '416-555-0131',
    buyerLawyerFax: '416-555-0132',

    // Form 371's own terms. Here rather than in a second fixture because the
    // endpoint takes the whole set in one PUT — a partial save clears whatever
    // it leaves out, so there is no such thing as "the 371 entries" on the wire.
    commencementTime: '9:00 a.m.',
    commencementDate: '2026-08-03',
    expiryDate: '2026-12-01',
    buyerRequirementsPropertyType: 'Detached or semi-detached residential, 3+ bedrooms',
    buyerRequirementsGeographicLocation: 'City of Toronto, north of Bloor Street',
    commissionPercent: '2.5',
    holdoverPeriodDays: 90
}

beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD)

    const brokerage = await prisma.brokerage.create({
        data: {
            name: 'Forms Routes Test Brokerage',
            address: '55 Yonge Street, Suite 400, Toronto, ON M5E 1J4',
            phone: '416-555-0142'
        }
    })

    brokerageId = brokerage.id

    const created = await prisma.agent.upsert({
        where: { email: EMAIL },
        update: { passwordHash, recoNumber: '4812277', phone: '416-555-0188', brokerageId },
        create: {
            email: EMAIL,
            name: 'Forms Routes Test Agent',
            passwordHash,
            recoNumber: '4812277',
            phone: '416-555-0188',
            brokerageId
        }
    })

    const other = await prisma.agent.upsert({
        where: { email: OTHER_EMAIL },
        update: {},
        create: { email: OTHER_EMAIL, name: 'Other Forms Routes Agent' }
    })

    agentId = created.id
    otherAgentId = other.id

    const owned = { agentId: { in: [agentId, otherAgentId] } }
    await prisma.complianceCheck.deleteMany({ where: { transactionForm: { transaction: owned } } })
    await prisma.transactionForm.deleteMany({ where: { transaction: owned } })
    await prisma.transactionEntries.deleteMany({ where: { transaction: owned } })
    await prisma.transactionParty.deleteMany({ where: { transaction: owned } })
    await prisma.transaction.deleteMany({ where: owned })

    const transaction = await prisma.transaction.create({
        data: {
            type: 'PURCHASE',
            agent: { connect: { id: agentId } },
            property: {
                create: {
                    address: '18 Maple Grove Avenue',
                    city: 'Toronto',
                    province: 'ON',
                    postalCode: 'M4K 2R7',
                    frontingSide: 'north',
                    frontingStreet: 'Maple Grove Avenue',
                    frontage: '30.02 feet',
                    depth: '120.5 feet',
                    legalDescription: 'LOT 42, PLAN 1187, CITY OF TORONTO'
                }
            },
            parties: {
                create: [
                    {
                        role: 'SELLER',
                        signingOrder: 1,
                        party: {
                            create: {
                                fullLegalName: 'Margaret Anne Whitfield',
                                email: 'm.whitfield@example.test',
                                phone: '647-555-0119',
                                address: '18 Maple Grove Avenue',
                                city: 'Toronto',
                                province: 'ON',
                                postalCode: 'M4K 2R7'
                            }
                        }
                    },
                    {
                        role: 'BUYER',
                        signingOrder: 2,
                        party: {
                            create: {
                                fullLegalName: 'Priya Raghunathan',
                                email: 'p.raghunathan@example.test',
                                phone: '416-555-0164',
                                address: '404 Sherbourne Street, Unit 12',
                                city: 'Toronto',
                                province: 'ON',
                                postalCode: 'M4X 1K2'
                            }
                        }
                    }
                ]
            }
        }
    })

    const theirs = await prisma.transaction.create({
        data: { type: 'PURCHASE', agentId: otherAgentId }
    })

    transactionId = transaction.id
    otherTransactionId = theirs.id
})

afterAll(async () => {
    await s3
        .send(
            new DeleteObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET,
                Key: keys.filledForm(transactionId, FORM)
            })
        )
        .catch(() => undefined)

    const owned = { agentId: { in: [agentId, otherAgentId] } }
    const parties = await prisma.transactionParty.findMany({
        where: { transaction: owned },
        select: { partyId: true }
    })

    await prisma.complianceCheck.deleteMany({ where: { transactionForm: { transaction: owned } } })
    await prisma.transactionForm.deleteMany({ where: { transaction: owned } })
    await prisma.transactionEntries.deleteMany({ where: { transaction: owned } })
    await prisma.transactionParty.deleteMany({ where: { transaction: owned } })
    await prisma.transaction.deleteMany({ where: owned })
    await prisma.party.deleteMany({ where: { id: { in: parties.map(p => p.partyId) } } })
    await prisma.agent.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } })
    await prisma.brokerage.deleteMany({ where: { id: brokerageId } })

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

const url = (path = '') => `/api/transactions/${transactionId}/forms/${FORM}${path}`

describe('the forms endpoints are behind the session guard', () => {
    test('every one of them is 401 without a session', async () => {
        const statuses = await Promise.all([
            request(app).get(url()),
            request(app).post(url('/fill')),
            request(app).get(url('/download')),
            request(app).get(url('/compliance'))
        ]).then(responses => responses.map(response => response.status))

        expect(statuses).toEqual([401, 401, 401, 401])
    })

    test("another agent's transaction is 404 on every one of them", async () => {
        const agent = await signIn()
        const theirs = `/api/transactions/${otherTransactionId}/forms/${FORM}`

        const statuses = await Promise.all([
            agent.get(theirs),
            agent.post(`${theirs}/fill`),
            agent.get(`${theirs}/download`),
            agent.get(`${theirs}/compliance`)
        ]).then(responses => responses.map(response => response.status))

        expect(statuses).toEqual([404, 404, 404, 404])
    })
})

describe('a transaction the gate blocks', () => {
    test('the fill is refused with 422 and the failure list', async () => {
        const agent = await signIn()

        const response = await agent.post(url('/fill'))

        expect(response.status).toEqual(422)
        expect(response.body.error).toEqual('compliance_failed')
        expect(response.body.compliance.passed).toEqual(false)
        expect(response.body.compliance.failures.length).toBeGreaterThan(0)

        // Each one says what it is and where it is fixed, not just a name.
        for (const failure of response.body.compliance.failures) {
            expect(failure.label.length).toBeGreaterThan(0)
            expect(failure.areaLabel.length).toBeGreaterThan(0)
        }
    })

    test('nothing was drawn — no PDF, not even a partial one', async () => {
        expect(await headObject(keys.filledForm(transactionId, FORM))).toBeNull()
    })

    test('the form is still DRAFT and there is nothing to download', async () => {
        const agent = await signIn()

        const form = await agent.get(url())

        expect(form.status).toEqual(200)
        expect(form.body.form.status).toEqual('DRAFT')
        expect(form.body.form.available).toEqual(false)
        // A row already exists — the refused gate wrote one to hang its check
        // off — so this reports partial progress rather than nothing: the
        // domain layer has answered its fields, the agreement terms have not.
        // The denominator is the set the gate reports against, so "n of m" on
        // screen and the checklist beside it count the same things.
        expect(form.body.form.fieldCount).toEqual(68)
        expect(form.body.form.filledCount).toBeGreaterThan(0)
        expect(form.body.form.filledCount).toBeLessThan(form.body.form.fieldCount)

        const download = await agent.get(url('/download'))

        expect(download.status).toEqual(404)
        expect(download.body.error).toEqual('form_not_filled')
    })

    test('the refusal is recorded as a failed check', async () => {
        const checks = await prisma.complianceCheck.findMany({
            where: { transactionForm: { transactionId } },
            orderBy: { checkedAt: 'desc' }
        })

        expect(checks.length).toBeGreaterThan(0)
        expect(checks[0].passed).toEqual(false)
        expect(Array.isArray(checks[0].missingFields)).toEqual(true)

        // There is no override path, so nothing ever writes to this column.
        expect(checks[0].overrides).toEqual([])
    })

    test('the compliance endpoint says the same thing without recording a check', async () => {
        const agent = await signIn()

        const before = await prisma.complianceCheck.count({
            where: { transactionForm: { transactionId } }
        })

        const response = await agent.get(url('/compliance'))

        expect(response.status).toEqual(200)
        expect(response.body.compliance.passed).toEqual(false)

        const after = await prisma.complianceCheck.count({
            where: { transactionForm: { transactionId } }
        })

        expect(after).toEqual(before)
    })
})

describe('a transaction the gate passes', () => {
    beforeAll(async () => {
        const agent = await signIn()

        const saved = await agent
            .put(`/api/transactions/${transactionId}/entries`)
            .send(completeEntries)

        expect(saved.status).toEqual(200)
    })

    test('the check passes once the agreement terms are in', async () => {
        const agent = await signIn()

        const response = await agent.get(url('/compliance'))

        expect(response.status).toEqual(200)
        expect(response.body.compliance.failures).toEqual([])
        expect(response.body.compliance.passed).toEqual(true)
    })

    test('the fill produces a form with every blank drawn', async () => {
        const agent = await signIn()

        const response = await agent.post(url('/fill'))

        expect(response.status).toEqual(200)
        expect(response.body.form.status).toEqual('FILLED')
        expect(response.body.form.available).toEqual(true)
        expect(response.body.form.formCode).toEqual(FORM)
        expect(response.body.truncated).toEqual([])

        // A form the gate passed reports every field filled. This once said 65
        // of 76: the count was taken over raw blanks, so the eleven ruled
        // continuation lines — which are three fields, expanded by the fill
        // engine — could never be counted, and a finished form could never
        // reach its own total. The gate was right and the number was wrong.
        expect(response.body.form.filledCount).toEqual(response.body.form.fieldCount)

        // No bucket path reaches the client. A filled agreement is read through
        // a presigned URL this service issues, never by a key a caller holds.
        expect(JSON.stringify(response.body)).not.toContain('transactions/')
    }, 30000)

    test('the passing check is recorded too', async () => {
        const checks = await prisma.complianceCheck.findMany({
            where: { transactionForm: { transactionId } },
            orderBy: { checkedAt: 'desc' }
        })

        expect(checks[0].passed).toEqual(true)
        expect(checks[0].missingFields).toEqual([])
    })

    test('a second form on the same transaction fills from the same terms', async () => {
        const agent = await signIn()

        // Form 371 is four pages against Form 100's six and shares most of its
        // answers. Filling it here proves the route is not Form 100 with the
        // code parameterised: a different page count, a different blank set and
        // a template that names its own required parties all go through it.
        const fill = await agent.post(`/api/transactions/${transactionId}/forms/371/fill`)

        expect(fill.status).toEqual(200)
        expect(fill.body.form.formCode).toEqual('371')
        expect(fill.body.form.status).toEqual('FILLED')
        expect(fill.body.truncated).toEqual([])

        const compliance = await agent.get(`/api/transactions/${transactionId}/forms/371/compliance`)

        expect(compliance.status).toEqual(200)
        expect(compliance.body.compliance.passed).toEqual(true)

        const download = await agent.get(`/api/transactions/${transactionId}/forms/371/download`)

        expect(download.status).toEqual(200)
        expect(download.body.fileName).toEqual('OREA-371-filled.pdf')
    }, 30000)

    test('the download is a short-lived link that fetches the PDF', async () => {
        const agent = await signIn()

        const response = await agent.get(url('/download'))

        expect(response.status).toEqual(200)
        expect(response.body.expiresInSeconds).toBeLessThanOrEqual(900)
        expect(response.body.fileName).toEqual('OREA-100-filled.pdf')

        // The saved name carries no client detail — a downloads folder should
        // not be the thing that names somebody's client.
        expect(response.body.fileName).not.toContain('Whitfield')

        const fetched = await fetch(response.body.url)

        expect(fetched.status).toEqual(200)
        expect(Buffer.from(await fetched.arrayBuffer()).subarray(0, 5).toString()).toEqual('%PDF-')
    }, 30000)
})

describe('a form the service cannot fill', () => {
    test('a form we have no template for is refused, not attempted', async () => {
        const agent = await signIn()

        // A form code the library has never had. Every OREA form we ship is
        // curated now, so this guards the refusal itself rather than standing
        // in for the next form waiting to be named.
        const response = await agent.get(`/api/transactions/${transactionId}/forms/999`)

        expect(response.status).toEqual(404)
        expect(response.body.error).toEqual('form_not_available')
    })

    test('a form code that is not one is refused without touching the filesystem', async () => {
        const agent = await signIn()

        const response = await agent.get(
            `/api/transactions/${transactionId}/forms/${encodeURIComponent('../../etc/passwd')}`
        )

        expect(response.status).toEqual(404)
        expect(response.body.error).toEqual('form_not_available')
    })
})

describe('GET /api/forms', () => {
    test('lists the curated library, ordered by code', async () => {
        const agent = await signIn()

        const response = await agent.get('/api/forms')

        expect(response.status).toEqual(200)

        const codes = response.body.forms.map((form: { code: string }) => form.code)

        // Exhaustive rather than a containment check: this endpoint is what the
        // frontend renders a form list from, so a form appearing or vanishing
        // is the thing worth failing on.
        expect(codes).toEqual(['100', '320', '371', '801'])
    })

    test('carries what a screen needs to name a form without asking again', async () => {
        const agent = await signIn()

        const response = await agent.get('/api/forms')
        const hundred = response.body.forms.find((form: { code: string }) => form.code === '100')

        expect(hundred).toEqual({
            code: '100',
            title: 'Agreement of Purchase and Sale',
            revision: 'May 2026',
            pageCount: 6,
            fieldCount: 68
        })
    })

    test('the field count is the denominator the per-form status counts against', async () => {
        const agent = await signIn()

        const [catalogue, status] = await Promise.all([
            agent.get('/api/forms'),
            agent.get(`/api/transactions/${transactionId}/forms/${FORM}`)
        ])

        const entry = catalogue.body.forms.find((form: { code: string }) => form.code === FORM)

        // Two endpoints, one number. A screen showing "19 of 30" must not be
        // able to get the 30 from one of them and the 19 from the other and
        // have them mean different things.
        expect(entry.fieldCount).toEqual(status.body.form.fieldCount)
    })

    test('without a session it is 401', async () => {
        const response = await request(app).get('/api/forms')

        expect(response.status).toEqual(401)
    })
})
