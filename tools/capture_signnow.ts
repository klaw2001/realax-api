/**
 * Capture real signNow responses into `test/fixtures/signnow/`.
 *
 * CLAUDE.md rule 2: never invent an external API response shape. The Zod
 * schemas in `src/integrations/signnow/` are built from what this script
 * captures, not from documentation. Nothing in `src/` may be written until the
 * fixtures exist.
 *
 * This is a throwaway tool, deliberately outside the application:
 *   - it imports nothing from `src/`, and reads `process.env` directly, so it
 *     cannot be broken by (or break) `config/env.ts`;
 *   - `tsconfig.json` is `"include": ["src/**\/*"]`, so `npm run typecheck`
 *     never sees this file. Keep it dependency-free and `unknown`-typed.
 *
 * Usage:
 *   npx ts-node -r dotenv/config tools/capture_signnow.ts <step> [--force]
 *   npx ts-node -r dotenv/config tools/capture_signnow.ts all
 *
 * Steps, in order:
 *   auth        POST /oauth2/token, password grant     free, optional
 *   auth-401    GET  /user with a bad bearer           free
 *   upload      POST /document (the BLANK Form 100)    1 document
 *   document    GET  /document/{id}                    free
 *   fields      PUT  /document/{id}, add sign fields   free
 *   download    GET  /document/{id}/download           free
 *   invite      POST /document/{id}/invite             1 invite, SENDS EMAIL
 *   invite-400  POST /document/{id}/invite, bad email  free
 *
 * Authentication is `SIGNNOW_API_KEY` (API Dashboard → Apps and Keys → API
 * Keys). `client_credentials` is not a supported grant — captured in
 * `oauth-token-unsupported-grant.json`.
 *
 * `invite` sends real email and consumes trial quota. It refuses to run
 * without `--yes-send-invites`.
 *
 * Rule 5: secrets never land in the repo. Every response is passed through
 * `redact()` before it is written, and the redactions are listed in
 * `test/fixtures/signnow/README.md`.
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const BASE = process.env.SIGNNOW_BASE_URL ?? 'https://api.signnow.com'
const CLIENT_ID = process.env.SIGNNOW_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.SIGNNOW_CLIENT_SECRET ?? ''
const USERNAME = process.env.SIGNNOW_USERNAME ?? ''
const PASSWORD = process.env.SIGNNOW_PASSWORD ?? ''

/**
 * A non-expiring bearer token from API Dashboard → Apps and Keys → API Keys.
 *
 * signNow's own guidance for "server-to-server automation that acts as a single
 * SignNow account" — which is exactly what REALAX is — is an API key rather
 * than the password grant: it does not expire, so there is no refresh logic to
 * maintain, and it is revoked by deleting it in the dashboard. Preferred here
 * because the alternative is the account's own login password sitting in `.env`.
 *
 * `client_credentials` is NOT a supported grant (captured: 400, code 1537).
 * The supported set is password, refresh_token and authorization_code.
 */
const API_KEY = process.env.SIGNNOW_API_KEY ?? ''

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'test', 'fixtures', 'signnow')
const SCRATCH = join(ROOT, 'logs', 'signnow-capture')
const STATE_FILE = join(FIXTURES, 'state.json')

/** The blank OREA form. No client data leaves this machine. */
const BLANK_FORM = join(ROOT, 'forms', 'sources', 'decrypted', '100.pdf')
const TEMPLATE = join(ROOT, 'forms', 'templates', '100.json')

const force = process.argv.includes('--force')
const allowInvites = process.argv.includes('--yes-send-invites')
const step = process.argv[2]

/** Signer addresses. Gmail plus-addressing, so both land in one inbox. */
const SIGNER_1 = process.env.SIGNNOW_CAPTURE_SIGNER_1 ?? ''
const SIGNER_2 = process.env.SIGNNOW_CAPTURE_SIGNER_2 ?? ''

let billableCalls = 0

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Keys whose value is replaced wholesale.
 *
 * Credentials, obviously (rule 5). Also personal names: `GET /user` returns the
 * account holder's real first and last name, and signer names appear on
 * documents and in webhook payloads. Rule 6 keeps client names out of logs and
 * error messages; a file committed to the repo forever is no better a place for
 * one.
 */
const SECRET_KEYS = new Set([
    'access_token',
    'refresh_token',
    'token',
    'api_key',
    'apiKey',
    'secret',
    'secret_key',
    'password',
    'client_secret',
    'first_name',
    'last_name',
    'owner_name',
    'signer_name',
    'full_name'
])

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/**
 * Replace credentials and real addresses, in place, recursively.
 *
 * The *shape* is what the Zod schemas are built from — a key with
 * `"<redacted>"` in it still proves the key exists and is a string, which is
 * all the schema needs. `expires_in`, `scope` and `token_type` are kept
 * because the client reads them.
 *
 * Emails are mapped to stable placeholders rather than removed, so a fixture
 * still shows which signer an event belongs to.
 */
const redact = (value: unknown, emails: Map<string, string>): unknown => {
    if (Array.isArray(value)) {
        return value.map(entry => redact(entry, emails))
    }

    if (value !== null && typeof value === 'object') {
        const output: Record<string, unknown> = {}

        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            output[key] = SECRET_KEYS.has(key) ? '<redacted>' : redact(entry, emails)
        }

        return output
    }

    if (typeof value === 'string') {
        return value.replace(EMAIL_PATTERN, match => {
            const known = emails.get(match.toLowerCase())

            if (known !== undefined) {
                return known
            }

            // An address we did not send. Still not ours to keep.
            const placeholder = `redacted-${createHash('sha256').update(match.toLowerCase()).digest('hex').slice(0, 8)}@example.test`
            emails.set(match.toLowerCase(), placeholder)

            return placeholder
        })
    }

    return value
}

const emailMap = () => {
    const map = new Map<string, string>()

    if (SIGNER_1 !== '') map.set(SIGNER_1.toLowerCase(), 'signer1@example.test')
    if (SIGNER_2 !== '') map.set(SIGNER_2.toLowerCase(), 'signer2@example.test')
    if (USERNAME !== '') map.set(USERNAME.toLowerCase(), 'owner@example.test')

    return map
}

// ---------------------------------------------------------------------------
// Fixture and state I/O
// ---------------------------------------------------------------------------

const save = (name: string, payload: unknown): void => {
    mkdirSync(FIXTURES, { recursive: true })

    const path = join(FIXTURES, name)
    writeFileSync(path, `${JSON.stringify(redact(payload, emailMap()), null, 2)}\n`)

    console.log(`  wrote test/fixtures/signnow/${name}`)
}

/**
 * A failure capture, with the status kept alongside the body.
 *
 * The status is not decoration here. signNow answers **400** for an invalid
 * bearer token, not 401, and returns `code: 1537` for both `invalid_request`
 * and `invalid_token` — so neither the HTTP status nor the numeric code
 * separates "your key is wrong" from "your request is wrong". The `error`
 * string is the only discriminant, and `SignNowError`'s `misconfigured` vs
 * `rejected` split depends on reading it.
 */
const saveError = (name: string, captured: Captured): void => {
    save(name, { status: captured.status, body: captured.body })
}

/**
 * The sender address an invite must be `from`.
 *
 * signNow only accepts the login email of the account that owns the token.
 * `GET /user` does **not** return an `email` field, which is the obvious guess
 * and is wrong — it returns `primary_email` plus an `emails` array of plain
 * strings. Sending `from: ""` is answered `From must not be empty` rather than
 * anything that names the real problem, so this is worth getting right once.
 *
 * Returned, never stored: the account address is not written to any committed
 * file.
 */
const senderEmail = (user: unknown): string => {
    if (typeof user !== 'object' || user === null) {
        return ''
    }

    const record = user as Record<string, unknown>

    if (typeof record.primary_email === 'string' && record.primary_email !== '') {
        return record.primary_email
    }

    const emails = record.emails

    return Array.isArray(emails) && typeof emails[0] === 'string' ? emails[0] : ''
}

/**
 * `GET /user`, cut down to the fields we read.
 *
 * The full response is ~17 KB of subscription, team, organization and
 * billing-period metadata that nothing in this codebase touches. It also
 * carries the account holder's real name in places key-based redaction cannot
 * reach — `"team": "<Name>'s Workspace Team"` embeds it mid-string. Dropping
 * those branches entirely is both the smaller fixture and the only reliable
 * redaction.
 *
 * Kept deliberately narrow: the client reads `primary_email` (and `emails` as a
 * fallback) to fill an invite's `from`, and `id` to scope a webhook
 * subscription. Nothing else.
 */
const saveUser = (captured: Captured): void => {
    const body = (captured.body ?? {}) as Record<string, unknown>
    const keep: Record<string, unknown> = {}

    for (const key of ['id', 'active', 'verified', 'type', 'pro', 'created', 'emails', 'primary_email', 'locale']) {
        keep[key] = body[key]
    }

    save('user-get.json', keep)
}

const have = (name: string): boolean => existsSync(join(FIXTURES, name))

const readState = (): Record<string, string> => {
    if (!existsSync(STATE_FILE)) {
        return {}
    }

    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, string>
}

const writeState = (patch: Record<string, string>): void => {
    mkdirSync(FIXTURES, { recursive: true })

    const next = { ...readState(), ...patch }
    writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`)

    console.log(`  state: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}`)
}

/** The document id every step after `upload` works against. */
const requireDocumentId = (): string => {
    const id = readState().documentId

    if (id === undefined || id === '') {
        throw new Error('No document id yet. Run the `upload` step first.')
    }

    return id
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface Captured {
    status: number
    ok: boolean
    body: unknown
}

/**
 * One call, with the status kept.
 *
 * A 4xx body is as much a capture as a 200 — the client has to tell
 * `misconfigured` from `rejected`, and that split is only writable against a
 * real error shape. So nothing throws on a non-2xx; the caller decides.
 */
const call = async (
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: BodyInit } = {}
): Promise<Captured> => {
    const url = new URL(path, BASE)

    console.log(`  ${method} ${url.pathname}`)

    const response = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        body: init.body
    })

    const text = await response.text()

    let body: unknown

    try {
        body = JSON.parse(text)
    } catch {
        body = { __nonJsonBody: text.slice(0, 2000) }
    }

    console.log(`    → ${response.status}`)

    return { status: response.status, ok: response.ok, body }
}

/**
 * An access token via the password grant.
 *
 * Only exercised to capture the `/oauth2/token` response shape. The client
 * itself uses `SIGNNOW_API_KEY`, so this is documentation of a path we have
 * chosen not to take — kept because the fixture is the evidence for that
 * choice, and because the refresh-token grant becomes relevant if the API key
 * is ever revoked in favour of per-user auth.
 *
 * The password grant works only for the *application owner*; any other user
 * gets access denied (code 11005001).
 */
const authenticate = async (
    secret = CLIENT_SECRET
): Promise<{ grant: string; captured: Captured; accessToken: string }> => {
    const basic = Buffer.from(`${CLIENT_ID}:${secret}`).toString('base64')

    const captured = await call('POST', '/oauth2/token', {
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'password',
            username: USERNAME,
            password: PASSWORD,
            scope: '*'
        }).toString()
    })

    const accessToken =
        captured.ok && typeof captured.body === 'object' && captured.body !== null
            ? String((captured.body as Record<string, unknown>).access_token ?? '')
            : ''

    return { grant: 'password', captured, accessToken }
}

/**
 * Whatever the rest of the steps authenticate with.
 *
 * The API key is preferred and is what `src/integrations/signnow/` will use.
 * The password grant is the fallback so a capture run is still possible before
 * the key has been copied out of the dashboard.
 */
const bearer = async (): Promise<string> => {
    if (API_KEY !== '') {
        return API_KEY
    }

    if (USERNAME === '' || PASSWORD === '') {
        throw new Error(
            'Set SIGNNOW_API_KEY in .env (API Dashboard → Apps and Keys → API Keys), ' +
                'or SIGNNOW_USERNAME and SIGNNOW_PASSWORD to use the password grant.'
        )
    }

    const { captured, accessToken } = await authenticate()

    if (!captured.ok || accessToken === '') {
        throw new Error(`Could not authenticate (${captured.status}). Run the \`auth\` step and read the fixture.`)
    }

    return accessToken
}

// ---------------------------------------------------------------------------
// Field geometry
// ---------------------------------------------------------------------------

interface Blank {
    name: string
    page: number
    bbox: [number, number, number, number]
    kind: string
}

/**
 * The signature and date blanks one signer fills, as signNow field rectangles.
 *
 * Our template is PDF user space: origin bottom-left, y increasing upward,
 * `bbox` is `[x0, y0, x1, y1]`. signNow's placement is almost certainly
 * top-left with y increasing downward, which is why `y` is flipped against the
 * page height here. **This conversion is a hypothesis until the `download`
 * step has been run and the PDF looked at** — record the answer in the README.
 */
const fieldsForRole = (role: 'buyer1' | 'seller1', pageHeight = 792) => {
    const template = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as { blanks: Blank[] }

    return template.blanks
        .filter(blank => blank.name.startsWith(`execution.${role}.`))
        .filter(blank => blank.kind === 'signature' || blank.kind === 'signingDate')
        // The witness line is not the signer's own.
        .filter(blank => !blank.name.endsWith('.witness'))
        .map(blank => {
            const [x0, y0, x1, y1] = blank.bbox

            return {
                name: blank.name,
                // signNow pages are zero-indexed in every example we have; ours
                // are one-indexed.
                page_number: blank.page - 1,
                type: blank.kind === 'signature' ? 'signature' : 'text',
                role: role.startsWith('buyer') ? 'Buyer' : 'Seller',
                required: true,
                x: Math.round(x0),
                y: Math.round(pageHeight - y1),
                width: Math.round(x1 - x0),
                height: Math.round(y1 - y0)
            }
        })
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const steps: Record<string, () => Promise<void>> = {
    async auth() {
        if (have('oauth-token.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        if (USERNAME === '' || PASSWORD === '') {
            console.log('  skipped: no SIGNNOW_USERNAME / SIGNNOW_PASSWORD.')
            console.log('  The client uses SIGNNOW_API_KEY instead, so this step is optional —')
            console.log('  it only captures the token response shape for the record.')
            return
        }

        const { grant, captured, accessToken } = await authenticate()

        save('oauth-token.json', captured.body)
        writeState({ grant, authenticated: accessToken === '' ? 'no' : 'yes' })

        if (!captured.ok) {
            console.log('\n  Authentication FAILED. The fixture holds the error body, which is')
            console.log('  itself worth having.')
        }
    },

    /**
     * The 401 envelope, captured against a real endpoint with a bad token.
     *
     * This is the shape `SignNowError` has to classify as `misconfigured` — a
     * revoked or mistyped key, where no retry can ever succeed — as distinct
     * from `unavailable`. Cheaper and more honest than a bad-secret token
     * request, because it is the failure the running service will actually meet.
     */
    async 'auth-401'() {
        if (have('invalid-token.error.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        const captured = await call('GET', '/user', {
            headers: { Authorization: 'Bearer deliberately-not-a-real-token' }
        })

        saveError('invalid-token.error.json', captured)
    },

    async upload() {
        if (have('document-upload.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        if (!existsSync(BLANK_FORM)) {
            throw new Error(`Missing ${BLANK_FORM}. Run the qpdf --decrypt step from CLAUDE.md.`)
        }

        const token = await bearer()
        const pdf = readFileSync(BLANK_FORM)

        const form = new FormData()
        form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'OREA-100-blank.pdf')

        billableCalls += 1

        const captured = await call('POST', '/document', {
            headers: { Authorization: `Bearer ${token}` },
            body: form
        })

        save('document-upload.json', captured.body)

        if (captured.ok && typeof captured.body === 'object' && captured.body !== null) {
            const id = String((captured.body as Record<string, unknown>).id ?? '')

            if (id !== '') {
                writeState({ documentId: id })

                // The id becomes an S3 key segment in 3.4 via keys.auditTrail().
                // SAFE_SEGMENT is /^[A-Za-z0-9][A-Za-z0-9_-]*$/ and throws on a
                // dot or a slash. Better to learn that here than after a
                // contract has been signed.
                const safe = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)
                console.log(`  document id is ${safe ? '' : 'NOT '}S3-key-safe: ${id}`)
                writeState({ documentIdIsS3Safe: safe ? 'yes' : 'no' })
            }
        }
    },

    async document() {
        if (have('document-get.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        const token = await bearer()
        const captured = await call('GET', `/document/${requireDocumentId()}`, {
            headers: { Authorization: `Bearer ${token}` }
        })

        save('document-get.json', captured.body)
    },

    async fields() {
        if (have('document-add-fields.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        const token = await bearer()
        const id = requireDocumentId()

        const request = { fields: [...fieldsForRole('seller1'), ...fieldsForRole('buyer1')] }

        save('document-add-fields.request.json', request)

        const captured = await call('PUT', `/document/${id}`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
        })

        save('document-add-fields.json', captured.body)

        const after = await call('GET', `/document/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
        })

        save('document-get-with-fields.json', after.body)
    },

    async download() {
        const token = await bearer()
        const id = requireDocumentId()

        const url = new URL(`/document/${id}/download?type=collapsed`, BASE)
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })

        mkdirSync(SCRATCH, { recursive: true })

        const path = join(SCRATCH, `${id}.pdf`)
        writeFileSync(path, Buffer.from(await response.arrayBuffer()))

        console.log(`    → ${response.status}`)
        console.log(`\n  Wrote ${path}`)
        console.log('  OPEN IT. The only question that matters: are the signature boxes')
        console.log('  on the execution lines on page 5, or mirrored to the top of the page?')
        console.log('  Mirrored means signNow y-origin is top-left and the flip in')
        console.log('  fieldsForRole() is right. Record the answer in the fixtures README.')
    },

    async invite() {
        if (have('document-invite.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        if (!allowInvites) {
            console.log('\n  REFUSED. This step sends real email and consumes trial invite quota.')
            console.log('  Re-run with --yes-send-invites when you are ready.')
            return
        }

        if (SIGNER_1 === '' || SIGNER_2 === '') {
            throw new Error('Set SIGNNOW_CAPTURE_SIGNER_1 and SIGNNOW_CAPTURE_SIGNER_2 in .env first.')
        }

        const token = await bearer()
        const id = requireDocumentId()

        // `from` must be the login email of the account that owns the API key.
        // Fetched rather than configured, so there is one fewer thing in `.env`
        // that can drift out of step with the key beside it. Held in memory
        // only — it is never written to a fixture unredacted.
        const user = await call('GET', '/user', { headers: { Authorization: `Bearer ${token}` } })
        saveUser(user)

        const sender = senderEmail(user.body)

        if (sender === '') {
            throw new Error('Could not read the account email from GET /user.')
        }

        // Roles were created implicitly by field placement, so their ids have to
        // be read back rather than assumed.
        const document = await call('GET', `/document/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
        })

        const roles = ((document.body as Record<string, unknown>).roles ?? []) as {
            unique_id: string
            name: string
        }[]

        const roleId = (name: string): string => {
            const found = roles.find(role => role.name === name)

            if (found === undefined) {
                throw new Error(`No "${name}" role on the document. Run the \`fields\` step first.`)
            }

            return found.unique_id
        }

        // `order` here is what actually gates sequential signing — 1 signs, and
        // only then is 2 invited. The role-level `signing_order` that came back
        // from field placement defaulted to "1" for both roles and is not what
        // governs. Seller first, matching the execution order on the form.
        const request = {
            document_id: id,
            to: [
                {
                    email: SIGNER_1,
                    role: 'Seller',
                    role_id: roleId('Seller'),
                    order: 1,
                    subject: 'REALAX capture — signer 1',
                    message: 'Capture run. Not a real transaction.'
                },
                {
                    email: SIGNER_2,
                    role: 'Buyer',
                    role_id: roleId('Buyer'),
                    order: 2,
                    subject: 'REALAX capture — signer 2',
                    message: 'Capture run. Not a real transaction.'
                }
            ],
            from: sender,
            subject: 'REALAX capture',
            message: 'Capture run. Not a real transaction.'
        }

        save('document-invite.request.json', request)

        billableCalls += 1

        const captured = await call('POST', `/document/${id}/invite`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
        })

        save('document-invite.json', captured.body)

        if (captured.ok) {
            console.log('\n  Invite sent. Now start the webhook capture server:')
            console.log('    npx ts-node -r dotenv/config tools/capture_signnow_webhooks.ts')
            console.log('  then sign as signer 1, then signer 2, from the emailed links.')
        }
    },

    async 'invite-400'() {
        if (have('document-invite.error.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        const token = await bearer()
        const id = requireDocumentId()

        const user = await call('GET', '/user', { headers: { Authorization: `Bearer ${token}` } })
        saveUser(user)
        const sender = senderEmail(user.body)

        // Malformed on purpose, and malformed in exactly ONE way: a valid
        // sender and a real role, with only the recipient address broken. An
        // invite missing several things answers for whichever it noticed first,
        // which would make the fixture evidence for the wrong failure.
        //
        // This is the envelope the client has to classify as `rejected` — the
        // request was understood and refused — rather than `misconfigured`.
        const captured = await call('POST', `/document/${id}/invite`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                document_id: id,
                from: sender,
                to: [{ email: 'not-an-email', role: 'Seller', order: 1 }]
            })
        })

        saveError('document-invite.error.json', captured)
    }
}

// ---------------------------------------------------------------------------

const FREE_ORDER = ['auth', 'auth-401', 'upload', 'document', 'fields', 'download', 'invite-400']

const main = async (): Promise<void> => {
    if (CLIENT_ID === '' || CLIENT_SECRET === '') {
        throw new Error('SIGNNOW_CLIENT_ID and SIGNNOW_CLIENT_SECRET must be set in .env')
    }

    const names = step === 'all' ? FREE_ORDER : [step ?? '']

    for (const name of names) {
        const run = steps[name]

        if (run === undefined) {
            console.log(`Unknown step: ${name}`)
            console.log(`Steps: ${Object.keys(steps).join(', ')}, or "all" for every free one.`)
            process.exitCode = 1
            return
        }

        console.log(`\n[${name}]`)
        await run()
    }

    console.log(`\nBillable calls this run: ${billableCalls}`)
}

main().catch((error: unknown) => {
    console.error(`\n${(error as Error).message}`)
    process.exitCode = 1
})
