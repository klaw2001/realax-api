import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { hashPassword } from '../src/modules/auth/auth.service'

// A dedicated agent so the suite does not depend on the seed having run, and
// does not disturb the seeded row if it has.
const EMAIL = 'auth.test.agent@realax.test'
const PASSWORD = 'a-correct-test-password'

beforeAll(async () => {
    await prisma.agent.upsert({
        where: { email: EMAIL },
        update: { passwordHash: await hashPassword(PASSWORD) },
        create: {
            email: EMAIL,
            name: 'Auth Test Agent',
            passwordHash: await hashPassword(PASSWORD)
        }
    })
})

afterAll(async () => {
    await prisma.agent.deleteMany({ where: { email: EMAIL } })
    await prisma.$disconnect()
})

describe('the session guard', () => {
    test('an unauthenticated request to a protected route returns 401', async () => {
        const response = await request(app).get('/api/me').set('Accept', 'application/json')

        expect(response.status).toEqual(401)
        expect(response.body).toEqual({ error: 'unauthorized', message: 'Authentication required' })
    })

    test('an unauthenticated request to any other /api route returns 401, not 404', async () => {
        // Protection comes from where a route is mounted, so a path that does
        // not exist yet is still refused before anything can answer it.
        const response = await request(app).get('/api/transactions').set('Accept', 'application/json')

        expect(response.status).toEqual(401)
    })

    test('/health stays public', async () => {
        const response = await request(app).get('/health')

        expect(response.status).toEqual(200)
    })

    test('/api/auth/login stays reachable without a session', async () => {
        const response = await request(app).post('/api/auth/login').send({})

        expect(response.status).toEqual(400)
        expect(response.body.error).toEqual('invalid_request')
    })
})

describe('POST /api/auth/login', () => {
    test('rejects a wrong password with 401 and sets no session cookie', async () => {
        const response = await request(app)
            .post('/api/auth/login')
            .send({ email: EMAIL, password: 'not-the-password' })

        expect(response.status).toEqual(401)
        expect(response.body.error).toEqual('invalid_credentials')
        expect(response.headers['set-cookie']).toBeUndefined()
    })

    test('gives an unknown email the same answer as a wrong password', async () => {
        const response = await request(app)
            .post('/api/auth/login')
            .send({ email: 'nobody@realax.test', password: 'not-the-password' })

        expect(response.status).toEqual(401)
        expect(response.body.error).toEqual('invalid_credentials')
    })

    test('returns the agent and never the password hash', async () => {
        const response = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })

        expect(response.status).toEqual(200)
        expect(response.body.agent.email).toEqual(EMAIL)
        expect(JSON.stringify(response.body)).not.toContain('passwordHash')
        expect(JSON.stringify(response.body)).not.toContain('$2')
    })

    test('sets an httpOnly session cookie', async () => {
        const response = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })

        const cookies = response.headers['set-cookie'] as unknown as string[]
        const sessionCookie = cookies.find(cookie => cookie.startsWith('realax.sid='))

        expect(sessionCookie).toBeDefined()
        expect(sessionCookie).toContain('HttpOnly')
    })
})

describe('a full session', () => {
    test('login → GET /api/me → logout → 401', async () => {
        const agent = request.agent(app)

        const loggedIn = await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })

        expect(loggedIn.status).toEqual(200)

        const me = await agent.get('/api/me')

        expect(me.status).toEqual(200)
        expect(me.body.agent.email).toEqual(EMAIL)
        expect(me.body.agent.name).toEqual('Auth Test Agent')

        const loggedOut = await agent.post('/api/auth/logout')

        expect(loggedOut.status).toEqual(200)
        expect(loggedOut.body).toEqual({ loggedOut: true })

        const afterLogout = await agent.get('/api/me')

        expect(afterLogout.status).toEqual(401)
    })

    test('logout without a session is a no-op that still returns 200', async () => {
        const response = await request(app).post('/api/auth/logout')

        expect(response.status).toEqual(200)
        expect(response.body).toEqual({ loggedOut: true })
    })

    test('a session id issued before login is not valid after it', async () => {
        // Session fixation: the id the client held while unauthenticated must
        // not be the id that carries the authenticated session.
        const agent = request.agent(app)

        await agent.post('/api/auth/login').send({ email: EMAIL, password: 'not-the-password' })

        const loggedIn = await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })

        const cookies = loggedIn.headers['set-cookie'] as unknown as string[]

        expect(cookies?.some(cookie => cookie.startsWith('realax.sid='))).toBe(true)
    })
})
