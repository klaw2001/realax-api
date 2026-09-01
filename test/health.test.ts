import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import { healthResponseSchema } from '../src/schemas/health'

// An integration test. `/health` exists to answer whether the real Postgres,
// Redis and S3 are reachable from this process, so mocking any of them would
// test nothing the endpoint is for.

afterAll(async () => {
    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

describe('GET /health', () => {
    test('reports every dependency and matches the published contract', async () => {
        const response = await request(app).get('/health').set('Accept', 'application/json')

        expect(() => healthResponseSchema.parse(response.body)).not.toThrow()

        // Named individually so a failure says which dependency is unreachable
        // rather than only that the status was not 'ok'.
        expect(response.body.checks.database.status).toEqual('up')
        expect(response.body.checks.redis.status).toEqual('up')
        expect(response.body.checks.storage.status).toEqual('up')

        expect(response.body.status).toEqual('ok')
        expect(response.status).toEqual(200)
    })

    test('reports a latency for each dependency', async () => {
        const response = await request(app).get('/health')

        for (const check of Object.values(response.body.checks) as { latencyMs: number }[]) {
            expect(typeof check.latencyMs).toEqual('number')
            expect(check.latencyMs).toBeGreaterThanOrEqual(0)
        }
    })
})
