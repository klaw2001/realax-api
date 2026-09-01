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
    await prisma.transaction.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } })
})

afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } })
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
