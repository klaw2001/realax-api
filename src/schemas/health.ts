import { registry, z } from '@/openapi/registry'

/**
 * One dependency's result.
 *
 * `latencyMs` is here because "up but taking 400ms" is the shape a failing
 * Neon or a cross-region S3 call takes before it starts erroring.
 */
export const dependencyCheckSchema = registry.register(
    'DependencyCheck',
    z.object({
        status: z.enum(['up', 'down']).openapi({ example: 'up' }),
        latencyMs: z.number().openapi({ example: 4 })
    })
)

/**
 * Response of `GET /health`.
 *
 * `degraded` is reported with a 503 so a load balancer or uptime check treats
 * it as failing without having to read the body. The body still says *which*
 * dependency is down — that is the difference between this and a bare probe.
 */
export const healthResponseSchema = registry.register(
    'HealthResponse',
    z.object({
        status: z.enum(['ok', 'degraded']).openapi({ example: 'ok' }),
        service: z.string().openapi({ example: 'realax-api' }),
        uptimeSeconds: z.number().openapi({ example: 12.35 }),
        timestamp: z.iso.datetime().openapi({ example: '2026-08-31T12:00:00.000Z' }),
        checks: z.object({
            database: dependencyCheckSchema,
            redis: dependencyCheckSchema,
            storage: dependencyCheckSchema
        })
    })
)

export type DependencyCheck = z.infer<typeof dependencyCheckSchema>
export type HealthResponse = z.infer<typeof healthResponseSchema>

registry.registerPath({
    method: 'get',
    path: '/health',
    summary: 'Liveness and dependency probe',
    description:
        'Unauthenticated. 200 while the service and all three dependencies ' +
        '(Postgres, Redis, S3) answer; 503 with the same body shape when any ' +
        'of them does not.',
    tags: ['health'],
    responses: {
        200: {
            description: 'Service and every dependency are up',
            content: {
                'application/json': {
                    schema: healthResponseSchema
                }
            }
        },
        503: {
            description: 'Service is up but at least one dependency is down',
            content: {
                'application/json': {
                    schema: healthResponseSchema
                }
            }
        }
    }
})
