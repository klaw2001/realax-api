import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import { invalidateListing } from '../src/integrations/repliers/cache'
import { hashPassword } from '../src/modules/auth/auth.service'
import { toPropertyDraft } from '../src/modules/property/property.service'
import { repliersListingSchema } from '../src/integrations/repliers/schema'

import listingFixture from './fixtures/repliers/get-listing.json'

// Two agents again: one to act as, one to prove a transaction cannot be read or
// written through by whoever knows its id.
const EMAIL = 'property.test.agent@realax.test'
const OTHER_EMAIL = 'property.test.other@realax.test'
const PASSWORD = 'a-correct-test-password'

const CAPTURED_MLS = listingFixture.mlsNumber
const CAPTURED_STREET = listingFixture.address.streetName

let agentId = ''
let otherAgentId = ''
let transactionId = ''
let otherTransactionId = ''

const signIn = async (email = EMAIL) => {
    const agent = request.agent(app)

    const response = await agent.post('/api/auth/login').send({ email, password: PASSWORD })

    expect(response.status).toEqual(200)

    return agent
}

/** The minimum a save needs. Individual tests spread over it. */
const form = {
    address: '18 Maple Grove Avenue',
    city: 'Toronto',
    province: 'ON'
}

const clearAgents = async () => {
    const ids = [agentId, otherAgentId].filter(Boolean)

    if (ids.length === 0) {
        return
    }

    // Properties are reached through their transaction, so the link has to be
    // dropped before the rows they point at can go.
    const transactions = await prisma.transaction.findMany({
        where: { agentId: { in: ids } },
        select: { propertyId: true }
    })

    const propertyIds = transactions
        .map(transaction => transaction.propertyId)
        .filter((id): id is string => id !== null)

    await prisma.transaction.deleteMany({ where: { agentId: { in: ids } } })
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } })
}

beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD)

    const created = await prisma.agent.upsert({
        where: { email: EMAIL },
        update: { passwordHash },
        create: { email: EMAIL, name: 'Property Test Agent', passwordHash }
    })

    const other = await prisma.agent.upsert({
        where: { email: OTHER_EMAIL },
        update: { passwordHash },
        create: { email: OTHER_EMAIL, name: 'Other Property Test Agent', passwordHash }
    })

    agentId = created.id
    otherAgentId = other.id

    await clearAgents()

    const transaction = await prisma.transaction.create({
        data: { type: 'LISTING', status: 'DRAFT', agentId },
        select: { id: true }
    })

    const otherTransaction = await prisma.transaction.create({
        data: { type: 'LISTING', status: 'DRAFT', agentId: otherAgentId },
        select: { id: true }
    })

    transactionId = transaction.id
    otherTransactionId = otherTransaction.id
})

afterAll(async () => {
    await clearAgents()
    await prisma.agent.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } })

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

describe('the property routes are behind the session guard', () => {
    test('search without a session is 401', async () => {
        const response = await request(app).get('/api/properties/search?q=Eudora')

        expect(response.status).toEqual(401)
    })

    test('an MLS lookup without a session is 401', async () => {
        const response = await request(app).get(`/api/properties/mls/${CAPTURED_MLS}`)

        expect(response.status).toEqual(401)
    })

    test('saving a property without a session is 401', async () => {
        const response = await request(app).put(`/api/transactions/${transactionId}/property`).send(form)

        expect(response.status).toEqual(401)
    })
})

/*
 * Mapping is tested against the captured listing rather than a live one: it is
 * the part that decides what lands on an OREA form, and it should be pinned to
 * a response that does not change under it.
 */
describe('an MLS listing maps onto the property form', () => {
    const listing = repliersListingSchema.parse(listingFixture)
    const draft = toPropertyDraft(listing)

    test('the address is one line, in the order the form fills it', () => {
        expect(draft.address).toEqual('7913 Eudora LN')
        expect(draft.city).toEqual('Austin')
        expect(draft.postalCode).toEqual('78747')
    })

    test('the legal description and price come straight across', () => {
        expect(draft.legalDescription).toEqual('LOT 7 BLK G SPRINGFIELD PHS B SEC 5')
        expect(draft.listPrice).toEqual(369000)
    })

    test('what MLS does not carry stays blank rather than being invented', () => {
        // Null on every sandbox listing, and blanks on the form the agent fills.
        expect(draft.frontage).toBeNull()
        expect(draft.depth).toBeNull()
        expect(draft.taxes).toBeNull()

        // No MLS field maps to the "on the ___ side of" blank at all.
        expect(draft.frontingSide).toBeNull()
    })

    test('a lot measurement is rendered as written, string or number', () => {
        const asNumber = toPropertyDraft(
            repliersListingSchema.parse({ ...listingFixture, lot: { width: 49.21, depth: '120' } })
        )

        expect(asNumber.frontage).toEqual('49.21')
        expect(asNumber.depth).toEqual('120')
    })

    test('a unit number is kept', () => {
        const withUnit = toPropertyDraft(
            repliersListingSchema.parse({
                ...listingFixture,
                address: { ...listingFixture.address, unitNumber: '1204' }
            })
        )

        expect(withUnit.address).toEqual('7913 Eudora LN Unit 1204')
    })

    test('annual taxes are formatted the way the form carries them', () => {
        const taxed = toPropertyDraft(
            repliersListingSchema.parse({
                ...listingFixture,
                taxes: { annualAmount: 4231, assessmentYear: '2024' }
            })
        )

        expect(taxed.taxes).toEqual('4,231.00')
    })
})

describe('PUT /api/transactions/:id/property', () => {
    test('a save creates the property and links it to the transaction', async () => {
        const agent = await signIn()

        const response = await agent.put(`/api/transactions/${transactionId}/property`).send({
            ...form,
            mlsNumber: CAPTURED_MLS,
            frontage: '49.21 feet',
            legalDescription: 'LOT 7 BLK G PLAN 66M-1234',
            listPrice: 1250000
        })

        expect(response.status).toEqual(200)
        expect(response.body.property.address).toEqual(form.address)
        expect(response.body.property.frontage).toEqual('49.21 feet')
        expect(response.body.property.listPrice).toEqual(1250000)

        const transaction = await prisma.transaction.findUnique({
            where: { id: transactionId },
            select: { propertyId: true }
        })

        expect(transaction?.propertyId).toEqual(response.body.property.id)
    })

    test('saving again edits the same row rather than orphaning one', async () => {
        const agent = await signIn()

        const before = await agent.get(`/api/transactions/${transactionId}/property`)

        const response = await agent
            .put(`/api/transactions/${transactionId}/property`)
            .send({ ...form, address: '20 Maple Grove Avenue', frontingSide: 'North' })

        expect(response.status).toEqual(200)
        expect(response.body.property.id).toEqual(before.body.property.id)
        expect(response.body.property.address).toEqual('20 Maple Grove Avenue')
        expect(response.body.property.frontingSide).toEqual('North')

        // The whole form is sent every time, so a field left out of the second
        // save is a field the agent cleared.
        expect(response.body.property.frontage).toBeNull()
        expect(response.body.property.listPrice).toBeNull()
    })

    test('the saved property survives a reload', async () => {
        const agent = await signIn()

        const response = await agent.get(`/api/transactions/${transactionId}/property`)

        expect(response.status).toEqual(200)
        expect(response.body.property.address).toEqual('20 Maple Grove Avenue')
        expect(response.body.property.city).toEqual('Toronto')
        expect(response.body.property.province).toEqual('ON')
    })

    test('an address is required — a form with none identifies no property', async () => {
        const agent = await signIn()

        const response = await agent
            .put(`/api/transactions/${transactionId}/property`)
            .send({ city: 'Toronto' })

        expect(response.status).toEqual(400)
        expect(response.body.error).toEqual('invalid_request')
        expect(response.body.message).toContain('address')
    })

    test("another agent's transaction is a 404, not a 403", async () => {
        const agent = await signIn()

        const read = await agent.get(`/api/transactions/${otherTransactionId}/property`)
        const write = await agent.put(`/api/transactions/${otherTransactionId}/property`).send(form)

        expect(read.status).toEqual(404)
        expect(write.status).toEqual(404)

        // And nothing was written through it.
        const untouched = await prisma.transaction.findUnique({
            where: { id: otherTransactionId },
            select: { propertyId: true }
        })

        expect(untouched?.propertyId).toBeNull()
    })

    test('a transaction with no property yet is a 404, not an empty body', async () => {
        const agent = await signIn(OTHER_EMAIL)

        const response = await agent.get(`/api/transactions/${otherTransactionId}/property`)

        expect(response.status).toEqual(404)
        expect(response.body.error).toEqual('property_not_found')
    })
})

/*
 * Live calls, for the same reason as in `repliers.test.ts`: the cache is primed
 * once and a re-run inside the 24h TTL bills nothing.
 */
describe('against the live Repliers API', () => {
    test('a search returns rows the dropdown can render', async () => {
        const agent = await signIn()

        const response = await agent.get(
            `/api/properties/search?q=${encodeURIComponent(CAPTURED_STREET)}&limit=5`
        )

        expect(response.status).toEqual(200)
        expect(response.body.results.length).toBeGreaterThan(0)
        expect(response.body.results[0].mlsNumber).toBeTruthy()
        expect(response.body.results[0].address).toBeTruthy()

        // The upstream total across pages, not the length of this page.
        expect(response.body.count).toBeGreaterThanOrEqual(response.body.results.length)
    }, 20_000)

    test('an empty query is answered without an outbound request', async () => {
        const agent = await signIn()

        const spy = jest.spyOn(globalThis, 'fetch')

        const response = await agent.get('/api/properties/search?q=')

        expect(response.status).toEqual(200)
        expect(response.body.results).toEqual([])
        expect(spy).not.toHaveBeenCalled()

        spy.mockRestore()
    })

    test('an MLS lookup returns a draft, and the second one is cached', async () => {
        const agent = await signIn()

        await invalidateListing(CAPTURED_MLS)

        const spy = jest.spyOn(globalThis, 'fetch')

        const first = await agent.get(`/api/properties/mls/${CAPTURED_MLS}`)

        expect(first.status).toEqual(200)
        expect(first.body.property.mlsNumber).toEqual(CAPTURED_MLS)
        expect(first.body.property.address).toBeTruthy()
        expect(spy).toHaveBeenCalledTimes(1)

        const second = await agent.get(`/api/properties/mls/${CAPTURED_MLS}`)

        expect(second.status).toEqual(200)
        expect(second.body).toEqual(first.body)
        expect(spy).toHaveBeenCalledTimes(1)

        spy.mockRestore()
    }, 20_000)

    test('an MLS number that matches nothing is a 404', async () => {
        const agent = await signIn()

        const response = await agent.get('/api/properties/mls/C9999999')

        expect(response.status).toEqual(404)
        expect(response.body.error).toEqual('listing_not_found')
    }, 20_000)
})
