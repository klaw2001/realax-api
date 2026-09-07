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

    // Whether the session cookie is sent on cross-site requests — which decides
    // `Secure` + `SameSite=None` on it, and whether Express trusts the proxy
    // that terminated TLS.
    //
    // Not derived from NODE_ENV. A staging or demo deploy serves the app and
    // the API from two hosts over HTTPS while running as `development`, because
    // the refinements below refuse the mock OCR and e-sign providers under
    // production. Keying the cookie off the environment name meant such a
    // deploy issued `SameSite=Lax` over a cross-site request, the browser
    // discarded it, and every call after login was anonymous — a login that
    // returns 200 and leaves the user logged out.
    //
    // Unset it and production behaviour is unchanged. Set it only where TLS
    // actually terminates in front of the service: `Secure` on a cookie served
    // over plain HTTP is dropped, so turning this on for a local `http://` run
    // breaks sessions rather than fixing them.
    COOKIE_CROSS_SITE: z.stringbool().optional(),

    // The `Domain` on the session cookie, when the app and the API are separate
    // hosts under one parent — `.example.com` for `app.example.com` and
    // `api.example.com`.
    //
    // Unset, the cookie is host-only: the browser returns it to the API and to
    // nowhere else. That is the tighter scope and the right default, but it
    // does not survive this app's route guard, which runs on the *frontend's*
    // server and reads the cookies the browser sent to the frontend host. A
    // host-only API cookie is not among them, so every protected page decides
    // nobody is signed in and redirects to the login it just came from.
    //
    // Local development never hit this: `localhost:4000` and `localhost:3005`
    // differ only by port, and cookies are not scoped by port.
    //
    // Widen this no further than necessary. The cookie is sent to every
    // subdomain of whatever is named here, so it must be a domain whose
    // subdomains are all ours.
    COOKIE_DOMAIN: z.string().min(1).optional(),

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
    REPLIERS_BASE_URL: z.url().default('https://api.repliers.io'),

    // OCR for identity documents (build plan 2.5). Named rather than assumed,
    // so swapping the vendor is a variable and a file under `integrations/ocr/`
    // rather than a search for every place that says Textract.
    // `textract` is production.
    //
    // The other two exist only because this AWS account is on the Free plan,
    // where Textract is a Paid-plan service and every `AnalyzeID` call is
    // refused. `azure` is the free development reader — Azure AI Document
    // Intelligence `prebuilt-idDocument`, F0 tier — and reads real cards.
    // `mock` reads nothing at all: fixtures, no network, no key, which is what
    // makes the identity flow demonstrable and testable offline.
    //
    // `barcode` is not OCR at all: it decodes the PDF417 on the back of a
    // driver's licence, which is text the issuing authority encoded rather than
    // characters recognised from an image. Free, offline, and the document
    // never leaves the process — but it needs the *back* of the card, so it is
    // a cross-check rather than a replacement.
    //
    // The refinement below forbids anything but Textract in production. A
    // provider is added here only once its client exists — the switch in
    // `integrations/ocr/index.ts` is exhaustive, so a name with no
    // implementation fails to compile rather than at the first upload.
    OCR_PROVIDER: z.enum(['textract', 'azure', 'mock', 'barcode']).default('textract'),

    // Demo mode (UX plan item 02).
    //
    // Turns on the one thing a demo cannot do without and production must never
    // have: a button that marks a party's identity verified without anybody
    // examining a document. Off unless the variable literally says so, and the
    // refinement below refuses to boot with it on in production.
    //
    // `z.stringbool` rather than `z.coerce.boolean`, which would read the
    // string "false" as true — the exact accident this flag cannot afford.
    DEMO_MODE: z.stringbool().default(false),

    // AnalyzeID runs in the same region as the bucket. Identity documents are
    // FINTRAC material and do not leave `ca-central-1` — including to be read.
    // Separate from AWS_REGION only so that a future non-AWS vendor does not
    // require repointing storage as well.
    OCR_REGION: z.string().min(1).default('ca-central-1'),

    // Field encryption for `IdentityRecord.documentNumber` (build plan 0.2
    // labels that column encrypted at rest). 32 bytes, hex or base64 —
    // `src/lib/encryption.ts` refuses anything else. Required, not optional: a
    // column documented as encrypted that silently holds plaintext because a
    // variable was unset is worse than one that never claimed to be. Generate
    // with:
    //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    //
    // Rotating it makes every existing document number unreadable. Values carry
    // a version prefix so a re-encryption migration can tell old from new.
    IDENTITY_ENCRYPTION_KEY: z
        .string()
        .min(32, 'IDENTITY_ENCRYPTION_KEY must decode to 32 bytes'),

    // Azure AI Document Intelligence — only read when `OCR_PROVIDER=azure`,
    // so both are optional here and required by the refinement below. Point the
    // endpoint at a Canada Central resource: identity documents are FINTRAC
    // material and the rest of this system is built so they do not leave the
    // country. Nothing enforces the region, so it is checked when the resource
    // is created.
    //   https://<resource-name>.cognitiveservices.azure.com/
    AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: z.url().optional(),

    // Key 1 or Key 2 from the resource's Keys and Endpoint blade.
    AZURE_DOCUMENT_INTELLIGENCE_KEY: z.string().min(1).optional(),

    // signNow (e-sign, build plan phase 3).
    //
    // `mock` signs nothing and talks to nobody: it returns a deterministic
    // document id and runs the real HMAC, so the whole signing flow is
    // testable and demonstrable without an API plan. The refinement below
    // forbids it in production.
    //
    // Defaulted to `mock` rather than to the real vendor — the opposite of
    // OCR_PROVIDER — because signNow API access is a separate annual
    // commitment and the trial lapses. A fresh checkout must boot without a
    // key; production is forced to `signnow` below, so the loose default costs
    // nothing.
    SIGNNOW_PROVIDER: z.enum(['signnow', 'mock']).default('mock'),

    SIGNNOW_BASE_URL: z.url().default('https://api.signnow.com'),

    // A non-expiring bearer token from API Dashboard → Apps and Keys → API
    // Keys, sent as `Authorization: Bearer`.
    //
    // Not OAuth. `client_credentials` is not a grant signNow supports (it
    // answers 400; the response is captured in
    // `test/fixtures/signnow/oauth-token-unsupported-grant.json`), and the
    // password grant would put the account's own login password in this file
    // and only ever work for the application owner. signNow's own guidance for
    // a backend acting as one account is an API key, which also means there is
    // no token to refresh and nothing to cache.
    //
    // Optional here, required by the refinement below when the provider is
    // `signnow`.
    SIGNNOW_API_KEY: z.string().min(1).optional(),

    // The shared secret signNow signs each webhook body with, sent back as
    // `X-SignNow-Signature`. We choose the value; signNow does not issue it. It
    // is set per subscription — `tools/signnow_subscriptions.ts` puts it on all
    // five — and without it signNow sends no signature header at all.
    //
    // This is the *only* authentication on `/webhooks/signnow`, which by
    // necessity sits outside the session guard: signNow has no session. An
    // unset secret means an unauthenticated public endpoint that writes to the
    // database, which is why the refinement requires it alongside the key.
    SIGNNOW_WEBHOOK_SECRET: z.string().min(1).optional(),

    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are deliberately absent. The
    // SDK's default credential chain reads them from the environment in
    // development and from the instance role in production; requiring them
    // here would make a correctly role-based deployment fail to boot.
})

/**
 * Cross-field rules — the ones a single variable cannot express.
 *
 * Both are about the OCR provider, and both fail on boot rather than at the
 * first upload: a reader that is configured wrong should stop the service, not
 * surface as a 502 the first time an agent photographs a licence.
 */
const validated = envSchema.superRefine((value, ctx) => {
    if (value.OCR_PROVIDER === 'azure') {
        if (value.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT === undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT'],
                message: 'required when OCR_PROVIDER is azure'
            })
        }

        if (value.AZURE_DOCUMENT_INTELLIGENCE_KEY === undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['AZURE_DOCUMENT_INTELLIGENCE_KEY'],
                message: 'required when OCR_PROVIDER is azure'
            })
        }
    }

    // The development readers are a free tier on an account that is not ours
    // to make promises about, and a fixture reader that verifies nobody, while
    // identity documents are FINTRAC material. Only Textract, in
    // `ca-central-1`, reads a real client's document.
    if (value.NODE_ENV === 'production' && value.OCR_PROVIDER !== 'textract') {
        ctx.addIssue({
            code: 'custom',
            path: ['OCR_PROVIDER'],
            message: 'must be textract in production'
        })
    }

    // Same rule, same reason. A demo override that verifies a party without a
    // document is a FINTRAC record of something that did not happen, and the
    // service refusing to start is a better outcome than one deploy where the
    // variable was set by mistake.
    if (value.NODE_ENV === 'production' && value.DEMO_MODE) {
        ctx.addIssue({
            code: 'custom',
            path: ['DEMO_MODE'],
            message: 'must be off in production'
        })
    }

    // The real signNow client needs both: the key to send anything, and the
    // webhook secret to believe anything that comes back. Neither is optional
    // once the provider is real — an envelope that can be created but whose
    // callbacks cannot be verified is worse than one that cannot be created.
    if (value.SIGNNOW_PROVIDER === 'signnow') {
        if (value.SIGNNOW_API_KEY === undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['SIGNNOW_API_KEY'],
                message: 'required when SIGNNOW_PROVIDER is signnow'
            })
        }

        if (value.SIGNNOW_WEBHOOK_SECRET === undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['SIGNNOW_WEBHOOK_SECRET'],
                message: 'required when SIGNNOW_PROVIDER is signnow'
            })
        }
    }

    // The mock returns a fabricated document id and invites nobody. Running it
    // in production would let an agent believe a real Agreement of Purchase and
    // Sale had been sent for signature when nothing left the building.
    if (value.NODE_ENV === 'production' && value.SIGNNOW_PROVIDER !== 'signnow') {
        ctx.addIssue({
            code: 'custom',
            path: ['SIGNNOW_PROVIDER'],
            message: 'must be signnow in production'
        })
    }
})

const parsed = validated.safeParse(process.env)

if (!parsed.success) {
    // Prints the offending variable names only. Values are never logged.
    const issues = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')

    throw new Error(`Invalid environment:\n${issues}`)
}

export const env = parsed.data

export const isProduction = env.NODE_ENV === 'production'

/**
 * Whether the session cookie has to survive a cross-site request.
 *
 * Production always does — the app and the API are separate hosts there. Any
 * other environment says so explicitly with `COOKIE_CROSS_SITE`, because
 * `development` covers both a local `http://localhost` run, where `Secure`
 * would break the cookie, and a two-subdomain HTTPS dev deploy, where its
 * absence does.
 */
export const crossSiteCookies = env.COOKIE_CROSS_SITE ?? isProduction
