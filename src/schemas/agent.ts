import { registry, z } from '@/openapi/registry'
import { errorContent } from '@/schemas/common'

/**
 * Session auth is a cookie, not a bearer token. Declaring it means the
 * generated frontend types describe a protected endpoint as protected.
 */
registry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: 'realax.sid'
})

/**
 * The authenticated agent, as returned by `GET /api/me` and by a successful
 * login.
 *
 * `passwordHash` is deliberately absent — this schema is what the controllers
 * parse their responses through, so the digest cannot reach the wire even if a
 * query forgets to narrow its `select`.
 */
export const agentSchema = registry.register(
    'Agent',
    z.object({
        id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),
        email: z.email().openapi({ example: 'darren@realax.test' }),
        name: z.string().openapi({ example: 'Darren Fischer' }),
        recoNumber: z.string().nullable().openapi({ example: '4812277' }),
        phone: z.string().nullable().openapi({ example: '416-555-0188' }),
        brokerageId: z.string().nullable().openapi({ example: 'seed_brokerage_0001' }),
        createdAt: z.iso.datetime().openapi({ example: '2026-09-01T09:00:00.000Z' })
    })
)

export type Agent = z.infer<typeof agentSchema>

export const loginRequestSchema = registry.register(
    'LoginRequest',
    z.object({
        email: z.email().openapi({ example: 'darren@realax.test' }),
        password: z.string().min(1).openapi({ example: 'correct horse battery staple' })
    })
)

export type LoginRequest = z.infer<typeof loginRequestSchema>

/**
 * Login and `GET /me` return the same envelope, so the frontend has one shape
 * to handle whether it just authenticated or is restoring an existing session.
 */
export const sessionResponseSchema = registry.register(
    'SessionResponse',
    z.object({
        agent: agentSchema
    })
)

export type SessionResponse = z.infer<typeof sessionResponseSchema>

export const logoutResponseSchema = registry.register(
    'LogoutResponse',
    z.object({
        loggedOut: z.literal(true).openapi({ example: true })
    })
)

export type LogoutResponse = z.infer<typeof logoutResponseSchema>

registry.registerPath({
    method: 'post',
    path: '/api/auth/login',
    summary: 'Start a session',
    description:
        'Unauthenticated. On success sets an httpOnly session cookie; the response body carries no token. Agent accounts only — there are no roles and no brokerage admin.',
    tags: ['auth'],
    request: {
        body: {
            required: true,
            content: { 'application/json': { schema: loginRequestSchema } }
        }
    },
    responses: {
        200: {
            description: 'Session started',
            content: { 'application/json': { schema: sessionResponseSchema } }
        },
        400: errorContent('Request body failed validation'),
        401: errorContent('Email or password is wrong')
    }
})

registry.registerPath({
    method: 'post',
    path: '/api/auth/logout',
    summary: 'End the current session',
    description:
        'Unauthenticated by design — calling it without a session is a no-op that still returns 200, so a client clearing stale state never has to handle a 401.',
    tags: ['auth'],
    responses: {
        200: {
            description: 'Session destroyed if one existed',
            content: { 'application/json': { schema: logoutResponseSchema } }
        }
    }
})

registry.registerPath({
    method: 'get',
    path: '/api/me',
    summary: 'The agent owning the current session',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session. The frontend route guard calls this: a 401 is the signal to redirect to the login page.',
    tags: ['auth'],
    responses: {
        200: {
            description: 'The authenticated agent',
            content: { 'application/json': { schema: sessionResponseSchema } }
        },
        401: errorContent('No session, or the session refers to an agent that no longer exists')
    }
})
