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

    // Cache only — nothing is stored here that cannot be rebuilt from Postgres
    // or re-fetched upstream. Defaults to a local server so a fresh checkout
    // boots without an extra variable; production must set it explicitly.
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

    // Signs the session cookie. Rotating it invalidates every live session,
    // which is the intended behaviour after a leak.
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

    // Explicit origin, not `*` — the frontend sends the session cookie, and a
    // wildcard origin is invalid with credentialed CORS.
    CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),

    // Storage. The bucket is Canadian-resident on purpose: identity documents
    // are FINTRAC material and do not leave `ca-central-1`.
    AWS_REGION: z.string().min(1).default('ca-central-1'),
    AWS_S3_BUCKET: z.string().min(1, 'AWS_S3_BUCKET is required'),

    // Required, not optional. Every object is written with SSE-KMS; without a
    // key id the first identity upload would be the thing that discovers it.
    AWS_KMS_KEY_ID: z.string().min(1, 'AWS_KMS_KEY_ID is required'),

    // MLS (build plan 1.3). Billed per request, and it lives here rather than
    // anywhere the frontend can reach. Required: a missing key must fail on
    // boot, not on the first property search in front of a client.
    REPLIERS_API_KEY: z.string().min(1, 'REPLIERS_API_KEY is required'),

    // Overridable so a test or a staging environment can be pointed elsewhere
    // without a code change.
    REPLIERS_BASE_URL: z.url().default('https://api.repliers.io')

    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are deliberately absent. The
    // SDK's default credential chain reads them from the environment in
    // development and from the instance role in production; requiring them
    // here would make a correctly role-based deployment fail to boot.
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
    // Prints the offending variable names only. Values are never logged.
    const issues = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')

    throw new Error(`Invalid environment:\n${issues}`)
}

export const env = parsed.data

export const isProduction = env.NODE_ENV === 'production'
