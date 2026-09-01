import { registry, z } from '@/openapi/registry'
import { brokerageSchema } from '@/schemas/brokerage'
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

/**
 * The agent's own profile (build plan 1.1).
 *
 * Same agent fields as `Agent`, plus the resolved brokerage. The brokerage is
 * embedded rather than left as an id the frontend has to look up: its address
 * and phone are the "dependent fields" the profile form fills in when a
 * brokerage is picked, and they must come from the same response that says
 * which brokerage is selected — otherwise a reload can render a selection
 * against stale detail.
 */
export const agentProfileSchema = registry.register(
    'AgentProfile',
    agentSchema.extend({
        // A union rather than `.nullable()`. A nullable `$ref` emits as
        // `allOf: [$ref, {type: [object, null]}]`, which openapi-typescript
        // renders as an intersection — and `Brokerage & null` collapses to
        // `never`, so the generated frontend type would claim this is always
        // present. The union emits `anyOf`, which generates as
        // `Brokerage | null`: what the API actually returns.
        brokerage: z.union([brokerageSchema, z.null()]).openapi({
            description: 'The selected preset, or null when the agent has not picked one.'
        })
    })
)

export type AgentProfile = z.infer<typeof agentProfileSchema>

export const agentProfileResponseSchema = registry.register(
    'AgentProfileResponse',
    z.object({
        profile: agentProfileSchema
    })
)

export type AgentProfileResponse = z.infer<typeof agentProfileResponseSchema>

/**
 * Profile update. Every field is optional — this is a PATCH, and an absent key
 * means "leave it alone".
 *
 * The nullable fields distinguish absent from `null` on purpose: `null` clears
 * the value, which is the only way to detach a brokerage or drop a phone
 * number once one has been set.
 *
 * `email` is not updatable here. It is the login identifier, and changing it is
 * an account operation rather than a profile edit.
 *
 * RECO numbers are validated only for length. They are registrant numbers
 * issued by RECO, and refusing a real one because it does not match a guessed
 * format would block an agent from completing their profile.
 */
export const updateAgentProfileRequestSchema = registry.register(
    'UpdateAgentProfileRequest',
    z.object({
        name: z.string().trim().min(1).max(120).optional().openapi({ example: 'Darren Fischer' }),
        recoNumber: z.string().trim().min(1).max(32).nullable().optional().openapi({ example: '4812277' }),
        phone: z.string().trim().min(1).max(32).nullable().optional().openapi({ example: '416-555-0188' }),
        brokerageId: z.string().trim().min(1).nullable().optional().openapi({
            description: 'Id of a brokerage from GET /api/agent/brokerages, or null to detach.',
            example: 'seed_brokerage_0001'
        })
    })
)

export type UpdateAgentProfileRequest = z.infer<typeof updateAgentProfileRequestSchema>

registry.registerPath({
    method: 'get',
    path: '/api/agent/profile',
    summary: "The signed-in agent's profile",
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session. Always the caller\'s own profile — there is no agent id in the path, because there is no way to read anyone else\'s.',
    tags: ['agent'],
    responses: {
        200: {
            description: 'The profile, with the selected brokerage resolved',
            content: { 'application/json': { schema: agentProfileResponseSchema } }
        },
        401: errorContent('No session')
    }
})

registry.registerPath({
    method: 'patch',
    path: '/api/agent/profile',
    summary: "Update the signed-in agent's profile",
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session. Partial: an absent field is unchanged, an explicit null clears it. Returns the saved profile, so the client renders what was stored rather than what it sent.',
    tags: ['agent'],
    request: {
        body: {
            required: true,
            content: { 'application/json': { schema: updateAgentProfileRequestSchema } }
        }
    },
    responses: {
        200: {
            description: 'The saved profile',
            content: { 'application/json': { schema: agentProfileResponseSchema } }
        },
        400: errorContent('Body failed validation, or brokerageId names a brokerage that does not exist'),
        401: errorContent('No session')
    }
})
