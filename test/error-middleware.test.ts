import express from 'express'
import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import { errorHandler, notFound } from '../src/middleware/error'
import { errorResponseSchema } from '../src/schemas/common'

// Build plan 2.3. The contract this suite is about is the frontend's
// `toApiError`: it parses every failed response for `{ error, message }` and
// falls back to the status line when it cannot. Express' own HTML page is what
// that fallback exists for, and this middleware is what stops it happening.

afterAll(async () => {
    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

/**
 * A throwaway app around one throwing route, so a real failure can be tested
 * without a route in the real app that fails on purpose.
 */
const appThatThrows = (thrown: unknown) => {
    const test = express()

    test.use(express.json())
    test.get('/boom', () => {
        throw thrown
    })
    test.get('/boom-async', (_req, _res, next) => {
        Promise.reject(thrown).catch(next)
    })
    test.post('/echo', (_req, res) => {
        res.status(200).json({ ok: true })
    })
    test.use(notFound)
    test.use(errorHandler)

    return test
}

describe('a thrown error leaves as the error envelope', () => {
    test('a synchronous throw is a 500 the client can parse', async () => {
        const response = await request(appThatThrows(new Error('the database is on fire'))).get(
            '/boom'
        )

        expect(response.status).toEqual(500)
        expect(response.type).toEqual('application/json')
        expect(errorResponseSchema.safeParse(response.body).success).toEqual(true)
        expect(response.body.error).toEqual('internal_error')
    })

    test('a rejected promise handed to next() is the same answer', async () => {
        const response = await request(appThatThrows(new Error('upstream timed out'))).get(
            '/boom-async'
        )

        expect(response.status).toEqual(500)
        expect(response.body.error).toEqual('internal_error')
    })

    test('something thrown that is not an Error is still an envelope', async () => {
        const response = await request(appThatThrows('a bare string')).get('/boom')

        expect(response.status).toEqual(500)
        expect(errorResponseSchema.safeParse(response.body).success).toEqual(true)
    })

    test('the message never carries what the error said', async () => {
        // An error thrown deep in a fill or an MLS call can carry a client's
        // name, an S3 key, or an upstream URL with a key in it.
        const secret = 'Margaret Anne Whitfield: s3://realax/transactions/tx_1/ids/p_1/licence.jpg'

        const response = await request(appThatThrows(new Error(secret))).get('/boom')

        expect(response.body.message).not.toContain('Margaret')
        expect(response.body.message).not.toContain('s3://')
        expect(JSON.stringify(response.body)).not.toContain('licence')
    })

    test('no stack trace reaches the client', async () => {
        const response = await request(appThatThrows(new Error('boom'))).get('/boom')

        expect(response.text).not.toContain('at ')
        expect(response.text).not.toContain('.ts:')
        expect(Object.keys(response.body).sort()).toEqual(['error', 'message'])
    })
})

describe('a malformed body is the request being wrong, not the server', () => {
    test('unparseable JSON is a 400 envelope', async () => {
        const response = await request(appThatThrows(new Error('unused')))
            .post('/echo')
            .set('Content-Type', 'application/json')
            .send('{"purchasePrice": ')

        expect(response.status).toEqual(400)
        expect(response.body.error).toEqual('invalid_json')
    })
})

describe('the real app', () => {
    test('answers an unmatched path with the envelope, not an HTML page', async () => {
        const response = await request(app).get('/definitely-not-a-route')

        expect(response.status).toEqual(404)
        expect(response.type).toEqual('application/json')
        expect(errorResponseSchema.safeParse(response.body).success).toEqual(true)
        expect(response.body.error).toEqual('not_found')
    })

    test('an unmatched path under /api is 401, not 404', async () => {
        const response = await request(app).get('/api/nothing-is-mounted-here')

        // The session guard is mounted in front of everything under /api, so
        // it answers before `notFound` can. That is the right order: an
        // unauthenticated caller does not get to enumerate which endpoints
        // exist. Still an envelope, which is what this suite is about.
        expect(response.status).toEqual(401)
        expect(response.type).toEqual('application/json')
        expect(errorResponseSchema.safeParse(response.body).success).toEqual(true)
    })

    test('malformed JSON on a real endpoint is a 400 envelope', async () => {
        const response = await request(app)
            .post('/api/auth/login')
            .set('Content-Type', 'application/json')
            .send('{"email": ')

        expect(response.status).toEqual(400)
        expect(response.body.error).toEqual('invalid_json')
    })
})
