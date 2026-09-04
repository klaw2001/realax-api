/**
 * Catch real signNow webhook callbacks and write them down.
 *
 * Standalone on port 4000, so the dev tunnel already registered in the signNow
 * dashboard needs no edit. **Stop `npm run dev` before running this** — they
 * want the same port.
 *
 *   npx ts-node -r dotenv/config tools/capture_signnow_webhooks.ts
 *
 * Each callback is written twice, and the split matters:
 *
 *   test/fixtures/signnow/webhook.<seq>.<event>.json   committed, REDACTED
 *       Signer emails replaced. This is what the Zod schema is built from and
 *       what `test/signnow-webhook.test.ts` posts. The tests sign these bytes
 *       themselves with a test secret, so they do not need signNow's signature.
 *
 *   logs/signnow-capture/webhook.<seq>.<event>.raw.bin   NOT committed
 *   logs/signnow-capture/webhook.<seq>.<event>.headers.json
 *       Byte-exact body and the real `x-signnow-signature`. `logs` is
 *       gitignored. Its one job is to confirm, once, by hand, that our HMAC
 *       implementation reproduces signNow's signature over a real payload —
 *       base64 of the *raw* sha256 digest, not base64 of the hex string.
 *       Verify it, note the result in the fixtures README, and it can be
 *       deleted. Redacting the body would change the bytes and destroy the
 *       signature, which is why these two files cannot be one file.
 *
 * Always answers 200. signNow unsubscribes a callback URL after 30 4xx in 60
 * minutes, and losing the subscription mid-capture would cost more than any
 * malformed payload.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import express from 'express'

const PORT = 4000
const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'test', 'fixtures', 'signnow')
const RAW = join(ROOT, 'logs', 'signnow-capture')

const SECRET = process.env.SIGNNOW_WEBHOOK_SECRET ?? ''
const SIGNER_1 = (process.env.SIGNNOW_CAPTURE_SIGNER_1 ?? '').toLowerCase()
const SIGNER_2 = (process.env.SIGNNOW_CAPTURE_SIGNER_2 ?? '').toLowerCase()
const USERNAME = (process.env.SIGNNOW_USERNAME ?? '').toLowerCase()

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

const placeholderFor = (address: string): string => {
    const lower = address.toLowerCase()

    if (lower === SIGNER_1) return 'signer1@example.test'
    if (lower === SIGNER_2) return 'signer2@example.test'
    if (lower === USERNAME) return 'owner@example.test'

    return `redacted-${createHash('sha256').update(lower).digest('hex').slice(0, 8)}@example.test`
}

const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact)

    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redact(entry)])
        )
    }

    if (typeof value === 'string') return value.replace(EMAIL_PATTERN, placeholderFor)

    return value
}

/**
 * signNow's own signature, recomputed.
 *
 * Their PHP reference is `base64_encode(hex2bin(hash_hmac('sha256', $payload,
 * $secret)))`, which is base64 of the *raw* digest — not base64 of the hex
 * string. Getting that wrong is the single easiest mistake in this
 * integration, so the capture run checks it while a real signature is in hand.
 */
const checkSignature = (raw: Buffer, header: string | undefined): string => {
    if (SECRET === '') return 'no SIGNNOW_WEBHOOK_SECRET set — cannot check'
    if (header === undefined) return 'no x-signnow-signature header'

    const expected = createHmac('sha256', SECRET).update(raw).digest()
    const actual = Buffer.from(header, 'base64')

    // timingSafeEqual throws on a length mismatch, so guard before comparing.
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual)

    return ok ? 'MATCHES — our HMAC is right' : 'DOES NOT MATCH — see the note in this file'
}

const nextSequence = (): string => {
    mkdirSync(FIXTURES, { recursive: true })

    const used = readdirSync(FIXTURES).filter(name => name.startsWith('webhook.')).length

    return String(used + 1).padStart(2, '0')
}

const app = express()

// Every content type, unparsed. The bytes are the point.
app.use(express.raw({ type: '*/*', limit: '5mb' }))

app.post('/webhooks/signnow', (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const header = req.header('x-signnow-signature')

    let parsed: unknown

    try {
        parsed = JSON.parse(raw.toString('utf8'))
    } catch {
        parsed = { __nonJsonBody: raw.toString('utf8').slice(0, 2000) }
    }

    // The event name lives at `meta.event`, NOT at the top level. The payload
    // is `{ meta: {...}, content: {...} }` — captured, not guessed.
    const eventType =
        typeof parsed === 'object' && parsed !== null
            ? String((((parsed as Record<string, unknown>).meta ?? {}) as Record<string, unknown>).event ?? 'unknown')
            : 'unknown'

    const seq = nextSequence()
    const stem = `webhook.${seq}.${eventType.replace(/[^A-Za-z0-9._-]/g, '_')}`

    mkdirSync(RAW, { recursive: true })

    writeFileSync(join(FIXTURES, `${stem}.json`), `${JSON.stringify(redact(parsed), null, 2)}\n`)
    writeFileSync(join(RAW, `${stem}.raw.bin`), raw)
    writeFileSync(
        join(RAW, `${stem}.headers.json`),
        `${JSON.stringify(req.headers, null, 2)}\n`
    )

    console.log(`\n[${seq}] ${eventType}  (${raw.length} bytes)`)
    console.log(`  signature: ${checkSignature(raw, header)}`)
    console.log(`  fixture:   test/fixtures/signnow/${stem}.json`)
    console.log(`  raw:       logs/signnow-capture/${stem}.raw.bin`)

    // Always 200. See the header comment.
    res.status(200).json({ received: true })
})

app.get('/webhooks/signnow', (_req, res) => {
    // signNow's "Validate link" button, and a convenient curl target.
    res.status(200).json({ ok: true })
})

app.listen(PORT, () => {
    if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true })

    console.log(`signNow webhook capture listening on :${PORT}`)
    console.log('Tunnel:  https://c41hgx1c-4000.inc1.devtunnels.ms/webhooks/signnow')
    console.log(SECRET === '' ? 'WARNING: SIGNNOW_WEBHOOK_SECRET not set — signatures will not be checked' : '')
    console.log('\nWaiting. Sign the invited document to produce events. Ctrl-C when done.')
})
