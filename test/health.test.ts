import request from 'supertest'

import app from '../src/app'
import { healthResponseSchema } from '../src/schemas/health'

describe('GET /health', () => {
    test('returns 200 and a body matching the published contract', async () => {
        const response = await request(app).get('/health').set('Accept', 'application/json')

        expect(response.status).toEqual(200)
        expect(() => healthResponseSchema.parse(response.body)).not.toThrow()
        expect(response.body.status).toEqual('ok')
    })
})
