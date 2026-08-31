import { registry, z } from '@/openapi/registry'

/**
 * Response of `GET /health`.
 *
 * Phase 0.5 extends this with per-dependency checks (db, redis, s3). Keep the
 * shape additive — the frontend compiles against the generated form of it.
 */
export const healthResponseSchema = registry.register(
    'HealthResponse',
    z.object({
        status: z.literal('ok').openapi({ example: 'ok' }),
        service: z.string().openapi({ example: 'realax-api' }),
        uptimeSeconds: z.number().openapi({ example: 12.35 }),
        timestamp: z.iso.datetime().openapi({ example: '2026-08-31T12:00:00.000Z' })
    })
)

export type HealthResponse = z.infer<typeof healthResponseSchema>

registry.registerPath({
    method: 'get',
    path: '/health',
    summary: 'Liveness probe',
    description: 'Unauthenticated. Returns 200 while the service is up.',
    tags: ['health'],
    responses: {
        200: {
            description: 'Service is up',
            content: {
                'application/json': {
                    schema: healthResponseSchema
                }
            }
        }
    }
})
