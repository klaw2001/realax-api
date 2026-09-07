import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import { hashPassword } from '../src/modules/auth/auth.service'
import { toEntryInput } from '../src/modules/entries/entries.service'
import { renderFilledForm } from '../src/modules/forms/fill.service'
import { buildMergedValues } from '../src/modules/forms/mapper.service'
import { loadTemplate } from '../src/modules/forms/template.service'
import type { TransactionEntries } from '../src/schemas/entries'

// Build plan 2.3. Two agents, so "belongs to someone else" is tested rather
// than assumed.
const EMAIL = 'entries.test.agent@realax.test'
const OTHER_EMAIL = 'entries.test.other@realax.test'
const PASSWORD = 'a-correct-test-password'

let agentId = ''
let otherAgentId = ''
let transactionId = ''
let otherTransactionId = ''

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
        create: { email: EMAIL, name: 'Entries Test Agent', passwordHash }
    })

    const other = await prisma.agent.upsert({
        where: { email: OTHER_EMAIL },
        update: {},
        create: { email: OTHER_EMAIL, name: 'Other Entries Test Agent' }
    })

    agentId = created.id
    otherAgentId = other.id

    const ids = { agentId: { in: [agentId, otherAgentId] } }
    await prisma.transactionEntries.deleteMany({ where: { transaction: ids } })
    await prisma.transaction.deleteMany({ where: ids })

    const mine = await prisma.transaction.create({ data: { type: 'LISTING', agentId } })
    const theirs = await prisma.transaction.create({
        data: { type: 'LISTING', agentId: otherAgentId }
    })

    transactionId = mine.id
    otherTransactionId = theirs.id
})

afterAll(async () => {
    const ids = { agentId: { in: [agentId, otherAgentId] } }
    await prisma.transactionEntries.deleteMany({ where: { transaction: ids } })
    await prisma.transaction.deleteMany({ where: ids })
    await prisma.agent.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } })

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

const complete = {
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
    chattelsIncluded: ['Refrigerator', 'Stove', 'Built-in dishwasher'],
    fixturesExcluded: ['Dining room chandelier'],
    rentalItems: ['Hot water tank'],
    hstTreatment: 'included in',
    propertyPresentUse: 'Single family residential',
    listingBrokerageName: 'Harbourfront Realty Group Ltd., Brokerage',
    listingBrokerageTel: '416-555-0148',
    listingBrokerageSalesperson: 'Dana Whitfield',
    coopBrokerageName: 'Bayview Heights Real Estate Ltd., Brokerage',
    coopBrokerageTel: '416-555-0173',
    coopBrokerageSalesperson: 'Alan Prakash',
    coopBrokerageAddress: '55 Yonge Street, Suite 400',
    coopBrokerageAddress2: 'Toronto, ON M5E 1J4',
    coopBrokerageFax: '416-555-0143',
    listingBrokerageAddress: '2900 Bayview Avenue, Unit 12',
    listingBrokerageAddress2: 'North York, ON M2K 1E6',
    listingBrokerageFax: '416-555-0174',
    coopCommissionAmount: '2.5% of the sale price',
    coopCommissionTerms: 'Paid from the deposit held in trust on completion.',
    sellerBrokerageCommentsSingle: 'None.',
    sellerBrokerageCommentsMultiple: 'None.',
    coopBrokerageComments: 'None.',
    offerSubmittedHow: 'by email',
    offerSubmittedTime: '4:15 p.m.',
    offerSubmittedDate: '2026-09-02',
    counterOfferBuyerNames: 'Priya Raghunathan',
    counterOfferSubmittedHow: 'by email',
    counterOfferSubmittedTime: '9:30 a.m.',
    counterOfferSubmittedDate: '2026-09-03',
    counterOfferIrrevocableTime: '11:59 p.m.',
    counterOfferIrrevocableDate: '2026-09-05',
    sellerContact: 'm.whitfield@example.test',
    offerReceivedHow: 'by email',
    offerReceivedTime: '4:20 p.m.',
    offerReceivedDate: '2026-09-02',
    offerPresentedHow: 'in person',
    offerPresentedTime: '7:00 p.m.',
    offerPresentedDate: '2026-09-02',
    offerComments: 'Buyer is flexible on the closing date.',
    designatedRepresentatives: 'Alan Prakash',
    commencementTime: '9:00 a.m.',
    commencementDate: '2026-08-03',
    expiryDate: '2026-12-01',
    buyerRequirementsPropertyType: 'Detached or semi-detached residential, 3+ bedrooms',
    buyerRequirementsGeographicLocation: 'City of Toronto, north of Bloor Street',
    additionalSchedulesList: 'B',
    commissionPercent: '2.5',
    commissionAlternative: 'A flat fee of $18,000.00 plus applicable taxes.',
    commissionLease: 'One month of the gross rent, plus applicable taxes.',
    holdoverPeriodDays: 90,
    sellerLawyerName: 'Hollis & Wren LLP',
    sellerLawyerAddress: '120 Adelaide Street West, Suite 900, Toronto, ON M5H 1T1',
    sellerLawyerEmail: 'conveyancing@holliswren.example.test',
    sellerLawyerTel: '416-555-0107',
    sellerLawyerFax: '416-555-0108',
    buyerLawyerName: 'Marchetti Law Professional Corporation',
    buyerLawyerAddress: '75 Front Street East, Suite 300, Toronto, ON M5E 1B8',
    buyerLawyerEmail: 'closings@marchettilaw.example.test',
    buyerLawyerTel: '416-555-0131',
    buyerLawyerFax: '416-555-0132'
}

describe('the entries endpoints are behind the session guard', () => {
    test('GET without a session is 401', async () => {
        const response = await request(app).get(`/api/transactions/${transactionId}/entries`)

        expect(response.status).toEqual(401)
    })

    test('PUT without a session is 401', async () => {
        const response = await request(app)
            .put(`/api/transactions/${transactionId}/entries`)
            .send(complete)

        expect(response.status).toEqual(401)
    })
})

describe('GET /api/transactions/:id/entries', () => {
    test('a transaction with nothing entered answers 200 with every field empty', async () => {
        const agent = await signIn()

        const response = await agent.get(`/api/transactions/${transactionId}/entries`)

        expect(response.status).toEqual(200)

        const entries = response.body.entries as TransactionEntries

        expect(entries.transactionId).toEqual(transactionId)
        expect(entries.purchasePrice).toBeNull()
        expect(entries.completionDate).toBeNull()

        // Lists are empty rather than null: a form with two empty states has
        // one of them untested.
        expect(entries.chattelsIncluded).toEqual([])
    })

    test("another agent's transaction is 404, the same as one that does not exist", async () => {
        const agent = await signIn()

        const theirs = await agent.get(`/api/transactions/${otherTransactionId}/entries`)
        const nothing = await agent.get('/api/transactions/does_not_exist/entries')

        expect(theirs.status).toEqual(404)
        expect(nothing.status).toEqual(404)
        expect(theirs.body).toEqual(nothing.body)
    })
})

describe('PUT /api/transactions/:id/entries', () => {
    test('saves the whole form and reads it back unchanged', async () => {
        const agent = await signIn()

        const saved = await agent.put(`/api/transactions/${transactionId}/entries`).send(complete)

        expect(saved.status).toEqual(200)
        expect(saved.body.entries).toMatchObject(complete)

        const read = await agent.get(`/api/transactions/${transactionId}/entries`)

        expect(read.body.entries).toEqual(saved.body.entries)
    })

    test('a field left out of the body is a field the agent cleared', async () => {
        const agent = await signIn()

        await agent.put(`/api/transactions/${transactionId}/entries`).send(complete)

        const { purchasePrice: _price, chattelsIncluded: _chattels, ...withoutThose } = complete
        const cleared = await agent
            .put(`/api/transactions/${transactionId}/entries`)
            .send(withoutThose)

        expect(cleared.status).toEqual(200)
        expect(cleared.body.entries.purchasePrice).toBeNull()
        expect(cleared.body.entries.chattelsIncluded).toEqual([])

        // And the rest is still there — a cleared field is one field, not the
        // form.
        expect(cleared.body.entries.completionDate).toEqual(complete.completionDate)
    })

    test('a price is stored to the cent, whatever it was written as', async () => {
        const agent = await signIn()

        const response = await agent
            .put(`/api/transactions/${transactionId}/entries`)
            .send({ ...complete, purchasePrice: '999999.5' })

        expect(response.status).toEqual(200)
        expect(response.body.entries.purchasePrice).toEqual('999999.50')
    })

    test('a price that is not a plain figure is refused, and the value is not echoed', async () => {
        const agent = await signIn()

        const response = await agent
            .put(`/api/transactions/${transactionId}/entries`)
            .send({ ...complete, purchasePrice: '$1,225,000' })

        expect(response.status).toEqual(400)
        expect(response.body.error).toEqual('invalid_request')
        expect(response.body.message).toContain('purchasePrice')
        expect(response.body.message).not.toContain('1,225,000')
    })

    test('a date that is not a calendar date is refused', async () => {
        const agent = await signIn()

        const response = await agent
            .put(`/api/transactions/${transactionId}/entries`)
            .send({ ...complete, completionDate: 'next Friday' })

        expect(response.status).toEqual(400)
        expect(response.body.message).toContain('completionDate')
    })

    test("another agent's transaction is 404 and writes nothing", async () => {
        const agent = await signIn()

        const response = await agent
            .put(`/api/transactions/${otherTransactionId}/entries`)
            .send(complete)

        expect(response.status).toEqual(404)

        const row = await prisma.transactionEntries.findUnique({
            where: { transactionId: otherTransactionId }
        })

        expect(row).toBeNull()
    })
})

describe('GET /api/transactions/:id', () => {
    test('returns the caller’s own transaction', async () => {
        const agent = await signIn()

        const response = await agent.get(`/api/transactions/${transactionId}`)

        expect(response.status).toEqual(200)
        expect(response.body.transaction.id).toEqual(transactionId)
        expect(response.body.transaction.agentId).toEqual(agentId)
        expect(response.body.transaction.type).toEqual('LISTING')
    })

    test("another agent's transaction is 404, the same as one that does not exist", async () => {
        const agent = await signIn()

        const theirs = await agent.get(`/api/transactions/${otherTransactionId}`)
        const nothing = await agent.get('/api/transactions/does_not_exist')

        expect(theirs.status).toEqual(404)
        expect(nothing.status).toEqual(404)
        expect(theirs.body).toEqual(nothing.body)
    })

    test('without a session it is 401', async () => {
        const response = await request(app).get(`/api/transactions/${transactionId}`)

        expect(response.status).toEqual(401)
    })
})

describe('entries as the field mapper reads them', () => {
    const filled: TransactionEntries = {
        ...complete,
        transactionId: 'tx_1',
        updatedAt: '2026-09-02T09:00:00.000Z'
    }

    test('covers every Form 100 blank the domain model cannot answer', async () => {
        // The domain layer at its most complete: an agent, a property, a buyer
        // and a seller. What it still cannot answer is what entries are for.
        const merged = buildMergedValues({
            transaction: { type: 'LISTING' },
            agent: {
                id: 'agent_1',
                email: 'darren@realax.test',
                name: 'Darren Fischer',
                recoNumber: '4812277',
                phone: '416-555-0188',
                brokerageId: 'brokerage_1',
                createdAt: '2026-09-01T09:00:00.000Z',
                brokerage: {
                    id: 'brokerage_1',
                    name: 'Realax Realty Inc., Brokerage',
                    address: '55 Yonge Street, Toronto',
                    phone: '416-555-0142'
                }
            },
            property: {
                id: 'property_1',
                mlsNumber: 'C8123456',
                address: '18 Maple Grove Avenue',
                city: 'Toronto',
                province: 'ON',
                postalCode: 'M4K 2R7',
                frontingSide: 'north',
                frontingStreet: 'Maple Grove Avenue',
                frontage: '30.02 feet',
                depth: '120.5 feet',
                legalDescription: 'LOT 42, PLAN 1187, CITY OF TORONTO',
                listPrice: 1249000,
                taxes: '6,842.17 (2025)'
            },
            parties: [
                {
                    id: 'tp_1',
                    personId: 'p_1',
                    role: 'SELLER',
                    signingOrder: 1,
                    fullLegalName: 'Margaret Anne Whitfield',
                    email: 'm.whitfield@example.test',
                    phone: '647-555-0119',
                    address: '18 Maple Grove Avenue',
                    city: 'Toronto',
                    province: 'ON',
                    postalCode: 'M4K 2R7',
                    dateOfBirth: null,
                    createdAt: '2026-09-02T09:00:00.000Z',
                    updatedAt: '2026-09-02T09:00:00.000Z'
                },
                {
                    id: 'tp_2',
                    personId: 'p_2',
                    role: 'BUYER',
                    signingOrder: 1,
                    fullLegalName: 'Priya Raghunathan',
                    email: 'p.raghunathan@example.test',
                    phone: '416-555-0164',
                    address: '404 Sherbourne Street, Unit 12',
                    city: 'Toronto',
                    province: 'ON',
                    postalCode: 'M4X 1K2',
                    dateOfBirth: null,
                    createdAt: '2026-09-02T09:00:00.000Z',
                    updatedAt: '2026-09-02T09:00:00.000Z'
                }
            ],
            entries: toEntryInput(filled)
        })

        // Asked of the fill engine rather than of the merged object, because
        // the merged object is not where the answer is for the ruled blocks:
        // those arrive under one name and the engine flows them across the
        // lines. What matters is that the form comes out with nothing left
        // blank, and that is what it reports.
        const rendered = await renderFilledForm(await loadTemplate('100'), merged)

        expect(rendered.missing).toEqual([])
        expect(rendered.truncated).toEqual([])
    })

    test('a date becomes the day, month and year the form prints separately', () => {
        const merged = buildMergedValues({
            transaction: { type: 'LISTING' },
            entries: toEntryInput(filled)
        })

        expect(merged['completion.dateDay']).toEqual('14')
        expect(merged['completion.dateMonth']).toEqual('November')
        expect(merged['completion.dateYear']).toEqual('26')

        // Schedule A has no date of its own — it follows the agreement's.
        expect(merged['scheduleA.dateDay']).toEqual('2')
        expect(merged['scheduleA.dateMonth']).toEqual('September')
    })

    test('money is grouped the way the form prints it', () => {
        const merged = buildMergedValues({
            transaction: { type: 'LISTING' },
            entries: toEntryInput(filled)
        })

        expect(merged['purchasePrice.numeric']).toEqual('1,225,000.00')
        expect(merged['deposit.amountNumeric']).toEqual('60,000.00')
    })

    test('a ruled block arrives as one value for the fill engine to wrap', () => {
        const merged = buildMergedValues({
            transaction: { type: 'LISTING' },
            entries: toEntryInput(filled)
        })

        // One value under the block's own name, not pre-broken into `.lineN`.
        // Only the fill engine has the font metrics to decide where it breaks.
        expect(merged.chattelsIncluded).toEqual('Refrigerator, Stove, Built-in dishwasher')
        expect(merged['chattelsIncluded.line1']).toBeUndefined()
    })

    test('an empty list is nothing to draw rather than an empty line', () => {
        const merged = buildMergedValues({
            transaction: { type: 'LISTING' },
            entries: toEntryInput({ ...filled, chattelsIncluded: [], rentalItems: [] })
        })

        expect(merged.chattelsIncluded).toBeUndefined()
        expect(merged.rentalItems).toBeUndefined()
    })
})
