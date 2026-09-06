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
 * Embedded signing (build plan 3.2). The success path uses a second document so
 * the shared one keeps its "fields and roles but no invite" property; the error
 * steps reuse the shared one, because a rejected request creates nothing.
 *
 *   embed-invite-400      POST v2 embedded-invites, bad email   free
 *   embed-upload          POST /document (the BLANK Form 100)   1 document
 *   embed-fields          PUT  /document/{id}, add sign fields  free
 *   embed-invite          POST v2 embedded-invites              1 invite, no email
 *   embed-link            POST v2 .../{invite}/link             free
 *   embed-link-order2     the same for signer 2, out of turn    free
 *   embed-link-400        the same for an invite that is not    free
 *   embed-document-after  GET  /document/{id}                   free
 *   embed-cleanup         DELETE v2 embedded-invites            free
 *
 * Authentication is `SIGNNOW_API_KEY` (API Dashboard → Apps and Keys → API
 * Keys). `client_credentials` is not a supported grant — captured in
 * `oauth-token-unsupported-grant.json`.
 *
 * `invite` sends real email and consumes trial quota. It refuses to run
 * without `--yes-send-invites`.
 *
 * `embed-invite` sends no email but is assumed billable, and refuses to run
 * without `--yes-embed-invites`. Run `embed-invite-400` first: if embedded
 * signing is not on the trial plan it answers 402/403, and there is no point
 * spending an invite to learn that twice.
 *
 * A signing link is a bearer credential — whoever holds it can sign as that
 * signer. It is redacted out of every fixture, by key name and by shape, and
 * printed to the terminal instead. See `redact()` and `reportLink()`.
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

/*
 * Its own flag, not `--yes-send-invites`.
 *
 * That one means "this sends real email", and an embedded invite sends none —
 * so anybody reasoning from its name would conclude no gate was needed here and
 * spend trial quota finding out otherwise. Until the capture proves different,
 * assume signNow charges per invite whether or not it posts a letter.
 */
const allowEmbedInvites = process.argv.includes('--yes-embed-invites')
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
    'full_name',

    /*
     * Embedded signing links (3.2).
     *
     * A signing link is a bearer credential: whoever holds it can execute the
     * contract as the named signer, without logging in to anything. It is the
     * single most dangerous thing this tool has ever had in its hands, and a
     * fixture is committed to the repository forever — so it is redacted by key
     * name here and, because guessing the key name is not a security control,
     * by shape in `redact()` as well.
     */
    'link',
    'url',
    'signing_link',
    'embedded_link',
    'invite_link',
    'link_url'
])

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/**
 * A URL carrying something long and opaque — a token, in other words.
 *
 * The key-name list above only works if we guessed the key name. This catches
 * the same value wherever it turns up: nested in a message body, inside a
 * larger string, or under a key signNow invented after this was written.
 *
 * A plain `https://api.signnow.com` has no long segment and survives, because a
 * redacted host would cost a reader the one thing the fixture was kept for.
 *
 * It over-matches, knowingly. The thumbnail URLs in `document-get.json` carry
 * the 40-hex document id in their path and will be redacted on any re-capture
 * of that fixture, as will a docs URL with a long hyphenated slug — nothing
 * separates `create-embedded-invite` from a base64 token by shape alone. That
 * is the direction to err in: losing a thumbnail URL costs a reader nothing
 * they cannot reconstruct from the id beside it, and keeping a signing token
 * costs a signature.
 */
const OPAQUE_URL_PATTERN = /https?:\/\/\S*[/=][A-Za-z0-9_-]{20,}\S*/g

/**
 * The application name signNow staples onto an embedded invite's address.
 *
 * `field_invites[].email` is not an email address. On an embedded invite it
 * reads `signer@example.test (someusername API Application 1788241603417)`, and
 * that username is the account holder's own — derived from the login address,
 * which is exactly what the email mapping exists to keep out of these files.
 * `EMAIL_PATTERN` replaces the address and leaves the parenthetical standing.
 *
 * The shape is preserved so a schema still learns that this field is a string
 * with something after the address, which is the part that would otherwise
 * surprise whoever writes the Zod for it.
 */
const APP_NAME_PATTERN = /\([^()]*\bAPI Application\b[^()]*\)/g

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
        // Before the email pass: a signing link can carry an address in its
        // query string, and the whole URL goes rather than just the address.
        const withoutLinks = value
            .replace(OPAQUE_URL_PATTERN, '<redacted-url>')
            .replace(APP_NAME_PATTERN, '(<redacted-app>)')

        return withoutLinks.replace(EMAIL_PATTERN, match => {
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

/**
 * The second document, the one the embedded steps invite against.
 *
 * Separate from `documentId` on purpose. That one "has fields and roles but no
 * invite, so re-running the read-only steps costs nothing" — a property the
 * fixtures README records and every free step depends on. Creating embedded
 * invites on it would destroy that, so the success path gets a document of its
 * own and the error paths keep using the shared one, where a rejected request
 * creates nothing.
 */
const requireEmbedDocumentId = (): string => {
    const id = readState().embedDocumentId

    if (id === undefined || id === '') {
        throw new Error('No embedded document id yet. Run the `embed-upload` step first.')
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

/**
 * The per-invite ids in an embedded-invite create response.
 *
 * Written defensively because the response shape is exactly what has not been
 * captured yet: signNow's documentation says `data[]`, the v1 invite answers
 * `{"status":"success"}` with no ids at all, and the fixtures README lists
 * eighteen findings of the form "the documentation would have got this wrong".
 * So this looks in the likely places rather than asserting one, and the caller
 * says so loudly when it finds nothing.
 *
 * Whatever it turns out to be, the README records it and the Zod schema is
 * written from the fixture — not from this function.
 */
const embeddedInviteIds = (body: unknown): string[] => {
    if (body === null || typeof body !== 'object') {
        return []
    }

    const root = body as Record<string, unknown>

    for (const key of ['data', 'invites', 'embedded_invites', 'field_invites']) {
        const list = root[key]

        if (!Array.isArray(list)) {
            continue
        }

        const ids = list
            .map(entry => {
                if (entry === null || typeof entry !== 'object') {
                    return ''
                }

                const record = entry as Record<string, unknown>

                return String(record.id ?? record.unique_id ?? record.invite_id ?? '')
            })
            .filter(id => id !== '')

        if (ids.length > 0) {
            return ids
        }
    }

    return []
}

/**
 * Print a signing link, to the terminal and nowhere else.
 *
 * `save()` redacts it — twice over, by key name and by shape — which is right
 * for a file that lives in git forever and useless for the operator, who has to
 * open the thing to answer the questions the capture exists to answer. So the
 * real value is printed, with a reminder of what it is.
 */
const reportLink = (captured: Captured): void => {
    if (!captured.ok || captured.body === null || typeof captured.body !== 'object') {
        return
    }

    const found: string[] = []

    const walk = (value: unknown): void => {
        if (typeof value === 'string' && /^https?:\/\//.test(value)) {
            found.push(value)
        } else if (Array.isArray(value)) {
            value.forEach(walk)
        } else if (value !== null && typeof value === 'object') {
            Object.values(value as Record<string, unknown>).forEach(walk)
        }
    }

    walk(captured.body)

    if (found.length === 0) {
        console.log('\n  No URL in the response. Read the fixture and record the real shape.')

        return
    }

    console.log('\n  SIGNING LINK — printed here only; the fixture has it redacted.')
    console.log('  Anyone holding this can sign as that signer. Do not paste it anywhere.')

    for (const link of found) {
        console.log(`    ${link}`)
    }

    console.log('\n  Open it once and record in the fixtures README:')
    console.log('    - does the page render inside an iframe, or does it frame-bust?')
    console.log('    - does it carry the "Development mode" trial watermark?')
    console.log('    - how long before the link stops working?')
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
    },

    // -----------------------------------------------------------------------
    // Embedded signing (build plan 3.2)
    //
    // A different endpoint family from everything above. `POST /document/{id}/
    // invite` is v1: it emails people and answers `{"status":"success"}` with
    // nothing to correlate. Embedded invites are v2, email nobody, and are
    // documented to answer with per-signer ids — which is the whole reason a
    // link can be minted at all. **Documented, not captured.** Every request
    // body below is a hypothesis built from signNow's documentation, which the
    // fixtures README already records as wrong about several things. The
    // capture is what settles it; nothing in `src/` may be written until these
    // fixtures exist (CLAUDE.md rule 2).
    // -----------------------------------------------------------------------

    async 'embed-upload'() {
        if (have('embedded-document-upload.json') && !force) {
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

        save('embedded-document-upload.json', captured.body)

        if (captured.ok && typeof captured.body === 'object' && captured.body !== null) {
            const id = String((captured.body as Record<string, unknown>).id ?? '')

            if (id !== '') {
                writeState({ embedDocumentId: id })
            }
        }
    },

    async 'embed-fields'() {
        if (have('embedded-document-add-fields.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        const token = await bearer()
        const id = requireEmbedDocumentId()

        // The same field set as the email path. Embedded signing changes who is
        // asked and how they arrive, not where the signature goes.
        const request = { fields: [...fieldsForRole('seller1'), ...fieldsForRole('buyer1')] }

        save('embedded-document-add-fields.request.json', request)

        const captured = await call('PUT', `/document/${id}`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
        })

        save('embedded-document-add-fields.json', captured.body)

        const after = await call('GET', `/document/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
        })

        save('embedded-document-get-with-fields.json', after.body)
    },

    /**
     * The refusal envelope, on the shared document because a rejection creates
     * nothing.
     *
     * Malformed in exactly one way — a real role id, a broken address — for the
     * same reason `invite-400` is: a request wrong in three ways answers for
     * whichever signNow noticed first, and the fixture becomes evidence for the
     * wrong failure.
     *
     * **This step is also how a plan-gate refusal gets captured.** If the trial
     * cannot create embedded invites at all, the answer here is a 402/403 with
     * an upgrade message rather than a validation error, and that body is the
     * most valuable thing in this whole exercise: it is the evidence for a
     * purchase decision. `call()` does not throw on a non-2xx, so it lands in
     * the fixture either way.
     */
    async 'embed-invite-400'() {
        if (have('embedded-invite-create.error.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        const token = await bearer()
        const id = requireDocumentId()

        const document = await call('GET', `/document/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
        })

        const roles = ((document.body as Record<string, unknown>).roles ?? []) as {
            unique_id: string
            name: string
        }[]

        const sellerRole = roles.find(role => role.name === 'Seller')

        if (sellerRole === undefined) {
            throw new Error('No "Seller" role on the shared document. Run the `fields` step first.')
        }

        const captured = await call('POST', `/v2/documents/${id}/embedded-invites`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                invites: [
                    {
                        email: 'not-an-email',
                        role_id: sellerRole.unique_id,
                        order: 1,
                        auth_method: 'none'
                    }
                ]
            })
        })

        saveError('embedded-invite-create.error.json', captured)

        if (captured.status === 402 || captured.status === 403) {
            console.log('\n  This looks like a PLAN GATE rather than a validation error.')
            console.log('  Embedded signing may not be available on the trial account.')
            console.log('  The fixture holds the refusal. Stop here, add a finding to the')
            console.log('  fixtures README, and take the purchase decision to a human —')
            console.log('  do not write anything in src/ against a shape we never received.')
        }
    },

    async 'embed-invite'() {
        if (have('embedded-invite-create.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        if (!allowEmbedInvites) {
            console.log('\n  REFUSED. This step creates invites and probably consumes trial quota.')
            console.log('  It sends no email — that is the point of embedded signing — but assume')
            console.log('  it is billed like any other invite until the capture proves otherwise.')
            console.log('  Re-run with --yes-embed-invites when you are ready.')
            return
        }

        if (SIGNER_1 === '' || SIGNER_2 === '') {
            throw new Error('Set SIGNNOW_CAPTURE_SIGNER_1 and SIGNNOW_CAPTURE_SIGNER_2 in .env first.')
        }

        const token = await bearer()
        const id = requireEmbedDocumentId()

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
                throw new Error(`No "${name}" role on the document. Run the \`embed-fields\` step first.`)
            }

            return found.unique_id
        }

        /*
         * `order` is here because sequential signing is the whole question.
         *
         * Finding 6 established that the invite's `order` is what gates the
         * sequence on the *email* family — evidence about v1, not about this.
         * If embedded ignores it, both signers can sign at once, and that
         * contradicts build plan 3.1 and the duplicate-position rejection in
         * `resolveSigners`. `embed-link-order2` is what measures it.
         */
        const request = {
            invites: [
                {
                    email: SIGNER_1,
                    role_id: roleId('Seller'),
                    order: 1,
                    auth_method: 'none'
                },
                {
                    email: SIGNER_2,
                    role_id: roleId('Buyer'),
                    order: 2,
                    auth_method: 'none'
                }
            ]
        }

        save('embedded-invite-create.request.json', request)

        billableCalls += 1

        const captured = await call('POST', `/v2/documents/${id}/embedded-invites`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
        })

        save('embedded-invite-create.json', captured.body)

        if (!captured.ok) {
            console.log('\n  Create FAILED. The fixture holds the error body, which is the')
            console.log('  evidence for whether this is a bad request or an unavailable feature.')
            return
        }

        const ids = embeddedInviteIds(captured.body)

        if (ids.length === 0) {
            console.log('\n  Created, but no invite ids could be found in the response.')
            console.log('  Read embedded-invite-create.json and record the real shape in the')
            console.log('  README — the link step needs a per-invite id, and if there is none')
            console.log('  then the whole per-signer link design has to be reconsidered.')
            return
        }

        writeState({
            embedInvite1: ids[0] ?? '',
            embedInvite2: ids[1] ?? ''
        })

        console.log(`\n  ${ids.length} invite id(s) captured. Next: embed-link.`)
    },

    async 'embed-link'() {
        if (have('embedded-invite-link.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        const token = await bearer()
        const id = requireEmbedDocumentId()
        const invite = readState().embedInvite1

        if (invite === undefined || invite === '') {
            throw new Error('No invite id yet. Run the `embed-invite` step first.')
        }

        const captured = await call(
            'POST',
            `/v2/documents/${id}/embedded-invites/${invite}/link`,
            {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ auth_method: 'none', link_expiration: 15 })
            }
        )

        save('embedded-invite-link.json', captured.body)

        reportLink(captured)
    },

    /**
     * A link for signer 2, before signer 1 has signed.
     *
     * The most important step in this file, and the reason the others exist.
     * "The next signer is invited automatically" is the acceptance criterion
     * for 3.2, and on the email path it is vendor behaviour we already have
     * evidence for (captured `webhook.05`). Embedded emails nobody, so
     * "invited" cannot mean "emailed" — the operational question becomes
     * whether a link minted for signer 2 works before signer 1 is done.
     *
     * Three outcomes, all worth having in a fixture:
     *
     *   refused    — the API enforces the turn itself and returns a specific
     *                409 rather than letting a vendor refusal surface as a 502.
     *   minted, and the hosted page says "waiting on a previous signer"
     *              — the API should still refuse, so the agent gets a message
     *                instead of handing somebody a dead end.
     *   minted, and it works
     *              — `order` is ignored, embedded signing is parallel, and
     *                sequential signing is *lost* by moving to it. A product
     *                decision, not something to work around quietly.
     */
    async 'embed-link-order2'() {
        if (have('embedded-invite-link-order2.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        const token = await bearer()
        const id = requireEmbedDocumentId()
        const invite = readState().embedInvite2

        if (invite === undefined || invite === '') {
            throw new Error('No second invite id. Run the `embed-invite` step first.')
        }

        const captured = await call(
            'POST',
            `/v2/documents/${id}/embedded-invites/${invite}/link`,
            {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ auth_method: 'none', link_expiration: 15 })
            }
        )

        if (captured.ok) {
            save('embedded-invite-link-order2.json', captured.body)

            console.log('\n  A link was minted for signer 2 while signer 1 has not signed.')
            console.log('  OPEN IT. If it lets signer 2 sign, `order` is not gating the sequence')
            console.log('  on the embedded path and 3.2 cannot be sequential. Record which it is')
            console.log('  in the README — this is a product decision, not an implementation one.')
        } else {
            saveError('embedded-invite-link-order2.error.json', captured)

            console.log('\n  Refused, which is the good outcome: the vendor gates the turn.')
            console.log('  The API should still refuse first, with a message naming whose turn')
            console.log('  it is, rather than passing this through as a 502.')
        }

        reportLink(captured)
    },

    async 'embed-link-400'() {
        if (have('embedded-invite-link.error.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        const token = await bearer()
        const id = requireEmbedDocumentId()

        // A well-formed id that belongs to no invite — so the refusal is about
        // the invite not existing, not about the id being unparseable.
        const captured = await call(
            'POST',
            `/v2/documents/${id}/embedded-invites/${'0'.repeat(40)}/link`,
            {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ auth_method: 'none', link_expiration: 15 })
            }
        )

        saveError('embedded-invite-link.error.json', captured)
    },

    async 'embed-document-after'() {
        if (have('embedded-document-get-after-invite.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        const token = await bearer()

        // Whether embedded invites surface in `field_invites`, in `roles`, or
        // nowhere. 3.4 has to find the audit trail from the document, and this
        // is where the path to it would show up.
        const captured = await call('GET', `/document/${requireEmbedDocumentId()}`, {
            headers: { Authorization: `Bearer ${token}` }
        })

        save('embedded-document-get-after-invite.json', captured.body)
    },

    /**
     * Remove the invite set.
     *
     * Captured because it is the only recovery path if create turns out not to
     * be idempotent — the resume branch in `signing.service.ts` has to do
     * something when it finds a document that was invited but whose envelope
     * row never landed, and "delete and re-create" is only an option if this
     * works.
     */
    async 'embed-cleanup'() {
        if (have('embedded-invite-delete.json') && !force) {
            console.log('  already captured; --force to redo')
            return
        }

        const token = await bearer()

        const captured = await call(
            'DELETE',
            `/v2/documents/${requireEmbedDocumentId()}/embedded-invites`,
            { headers: { Authorization: `Bearer ${token}` } }
        )

        save('embedded-invite-delete.json', captured.body)
    }
}

// ---------------------------------------------------------------------------

const FREE_ORDER = [
    'auth',
    'auth-401',
    'upload',
    'document',
    'fields',
    'download',
    'invite-400',
    'embed-invite-400'
]

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
