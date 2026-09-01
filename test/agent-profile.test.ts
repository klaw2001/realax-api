import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import { hashPassword } from '../src/modules/auth/auth.service'

// A dedicated agent and brokerages, so the suite neither depends on the seed
// having run nor edits the seeded agent's profile out from under it.
const EMAIL = 'profile.test.agent@realax.test'
const PASSWORD = 'a-correct-test-password'

const BROKERAGE_A = 'test_brokerage_a'
const BROKERAGE_B = 'test_brokerage_b'

/** Log in and return an agent that carries the session cookie. */
const signIn = async () => {
    const agent = request.agent(app)

    const response = await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })

    expect(response.status).toEqual(200)

    return agent
}

beforeAll(async () => {
    await prisma.brokerage.upsert({
        where: { id: BROKERAGE_A },
        update: {},
        create: {
            id: BROKERAGE_A,
            name: 'AAA Test Brokerage',
            address: '1 Test Street, Toronto, ON M1M 1M1',
            phone: '416-555-0101'
        }
    })

    await prisma.brokerage.upsert({
        where: { id: BROKERAGE_B },
        update: {},
        create: {
            id: BROKERAGE_B,
            name: 'BBB Test Brokerage',
            address: '2 Test Street, Ottawa, ON K1K 1K1',
            // Null on purpose: the schema allows a brokerage without a phone,
            // and the form has to render that rather than print "null".
            phone: null
        }
    })

    await prisma.agent.upsert({
        where: { email: EMAIL },
        update: {
            passwordHash: await hashPassword(PASSWORD),
            name: 'Profile Test Agent',
            recoNumber: null,
            phone: null,
            brokerageId: null
        },
        create: {
            email: EMAIL,
            name: 'Profile Test Agent',
            passwordHash: await hashPassword(PASSWORD)
        }
    })
})

afterAll(async () => {
    await prisma.agent.deleteMany({ where: { email: EMAIL } })
    await prisma.brokerage.deleteMany({ where: { id: { in: [BROKERAGE_A, BROKERAGE_B] } } })

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

describe('the agent module is behind the session guard', () => {
    test('GET /api/agent/profile without a session is 401', async () => {
        const response = await request(app).get('/api/agent/profile')

        expect(response.status).toEqual(401)
    })

    test('PATCH /api/agent/profile without a session is 401', async () => {
        const response = await request(app).patch('/api/agent/profile').send({ name: 'Nobody' })

        expect(response.status).toEqual(401)
    })

    test('GET /api/agent/brokerages without a session is 401', async () => {
        const response = await request(app).get('/api/agent/brokerages')

        expect(response.status).toEqual(401)
    })
})

describe('GET /api/agent/brokerages', () => {
    test('returns the preset table ordered by name', async () => {
        const agent = await signIn()

        const response = await agent.get('/api/agent/brokerages')

        expect(response.status).toEqual(200)

        const names = response.body.brokerages.map((brokerage: { name: string }) => brokerage.name)

        expect(names).toContain('AAA Test Brokerage')
        expect(names).toContain('BBB Test Brokerage')

        // Compared with `localeCompare`, not `.sort()`. Postgres orders by the
        // database collation, which is what a reader of the select expects;
        // the default `.sort()` orders by code point and would put "BBB"
        // ahead of "Bayview".
        expect([...names].sort((a: string, b: string) => a.localeCompare(b))).toEqual(names)
    })

    test('each preset carries the address and phone the profile form displays', async () => {
        const agent = await signIn()

        const response = await agent.get('/api/agent/brokerages')

        const found = response.body.brokerages.find(
            (brokerage: { id: string }) => brokerage.id === BROKERAGE_A
        )

        expect(found).toEqual({
            id: BROKERAGE_A,
            name: 'AAA Test Brokerage',
            address: '1 Test Street, Toronto, ON M1M 1M1',
            phone: '416-555-0101'
        })
    })
})

describe('GET /api/agent/profile', () => {
    test('returns the caller own profile and never the password hash', async () => {
        const agent = await signIn()

        const response = await agent.get('/api/agent/profile')

        expect(response.status).toEqual(200)
        expect(response.body.profile.email).toEqual(EMAIL)
        expect(response.body.profile.name).toEqual('Profile Test Agent')
        expect(response.body.profile.brokerage).toBeNull()
        expect(JSON.stringify(response.body)).not.toContain('passwordHash')
        expect(JSON.stringify(response.body)).not.toContain('$2')
    })
})

describe('PATCH /api/agent/profile', () => {
    test('persists the edited fields and returns what was saved', async () => {
        const agent = await signIn()

        const response = await agent
            .patch('/api/agent/profile')
            .send({ name: 'Edited Name', recoNumber: '4812277', phone: '416-555-0188' })

        expect(response.status).toEqual(200)
        expect(response.body.profile.name).toEqual('Edited Name')
        expect(response.body.profile.recoNumber).toEqual('4812277')
        expect(response.body.profile.phone).toEqual('416-555-0188')

        // Read back on a fresh request — this is the "reload retains
        // everything" criterion, checked against the store rather than against
        // the response just rendered.
        const reloaded = await agent.get('/api/agent/profile')

        expect(reloaded.body.profile).toEqual(response.body.profile)
    })

    test('selecting a brokerage resolves its address and phone onto the profile', async () => {
        const agent = await signIn()

        const response = await agent.patch('/api/agent/profile').send({ brokerageId: BROKERAGE_A })

        expect(response.status).toEqual(200)
        expect(response.body.profile.brokerageId).toEqual(BROKERAGE_A)
        expect(response.body.profile.brokerage).toEqual({
            id: BROKERAGE_A,
            name: 'AAA Test Brokerage',
            address: '1 Test Street, Toronto, ON M1M 1M1',
            phone: '416-555-0101'
        })
    })

    test('changing the brokerage changes the dependent fields with it', async () => {
        const agent = await signIn()

        await agent.patch('/api/agent/profile').send({ brokerageId: BROKERAGE_A })

        const response = await agent.patch('/api/agent/profile').send({ brokerageId: BROKERAGE_B })

        expect(response.body.profile.brokerage.address).toEqual('2 Test Street, Ottawa, ON K1K 1K1')
        expect(response.body.profile.brokerage.phone).toBeNull()
    })

    test('an absent field is left alone, an explicit null clears it', async () => {
        const agent = await signIn()

        await agent
            .patch('/api/agent/profile')
            .send({ name: 'Keep Me', recoNumber: '4812277', phone: '416-555-0188' })

        // `recoNumber` is not in the body at all, so it must survive.
        const cleared = await agent.patch('/api/agent/profile').send({ phone: null })

        expect(cleared.status).toEqual(200)
        expect(cleared.body.profile.phone).toBeNull()
        expect(cleared.body.profile.recoNumber).toEqual('4812277')
        expect(cleared.body.profile.name).toEqual('Keep Me')
    })

    test('null detaches the brokerage', async () => {
        const agent = await signIn()

        await agent.patch('/api/agent/profile').send({ brokerageId: BROKERAGE_A })

        const response = await agent.patch('/api/agent/profile').send({ brokerageId: null })

        expect(response.body.profile.brokerageId).toBeNull()
        expect(response.body.profile.brokerage).toBeNull()
    })

    test('an unknown brokerage is a 400, not a constraint violation', async () => {
        const agent = await signIn()

        const response = await agent.patch('/api/agent/profile').send({ brokerageId: 'no_such_brokerage' })

        expect(response.status).toEqual(400)
        expect(response.body.error).toEqual('unknown_brokerage')
    })

    test('an empty name is rejected and names the field', async () => {
        const agent = await signIn()

        const response = await agent.patch('/api/agent/profile').send({ name: '   ' })

        expect(response.status).toEqual(400)
        expect(response.body.error).toEqual('invalid_request')
        expect(response.body.message).toContain('name')
    })

    test('email is not editable through the profile', async () => {
        const agent = await signIn()

        await agent.patch('/api/agent/profile').send({ email: 'someone.else@realax.test' })

        const reloaded = await agent.get('/api/agent/profile')

        expect(reloaded.body.profile.email).toEqual(EMAIL)
    })

    test('one agent cannot edit another, because the id comes from the session', async () => {
        const agent = await signIn()

        // There is no agent id anywhere in the request surface. The closest a
        // caller can get is smuggling one into the body, which the schema drops.
        const response = await agent
            .patch('/api/agent/profile')
            .send({ id: 'seed_agent_9999', name: 'Session Wins' })

        expect(response.status).toEqual(200)
        expect(response.body.profile.email).toEqual(EMAIL)
        expect(response.body.profile.name).toEqual('Session Wins')
    })
})
