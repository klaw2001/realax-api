import { z } from 'zod'

/**
 * Zod-validated `process.env`.
 *
 * The point is to fail on boot rather than at the first request that needs a
 * variable — a missing `SESSION_SECRET` must not surface as sessions that
 * silently sign with `undefined`.
 *
 * Only variables the service actually reads are listed. Unknown keys are
 * ignored, so the starter's leftover entries do not have to be cleaned out of
 * `.env` before this passes.
 */
const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // Signs the session cookie. Rotating it invalidates every live session,
    // which is the intended behaviour after a leak.
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

    // Explicit origin, not `*` — the frontend sends the session cookie, and a
    // wildcard origin is invalid with credentialed CORS.
    CORS_ORIGIN: z.string().min(1).default('http://localhost:3000')
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
    // Prints the offending variable names only. Values are never logged.
    const issues = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')

    throw new Error(`Invalid environment:\n${issues}`)
}

export const env = parsed.data

export const isProduction = env.NODE_ENV === 'production'
