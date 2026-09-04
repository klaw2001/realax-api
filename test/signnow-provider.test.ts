import './helpers/signNowMock'

import { createHmac } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import { signNowProvider } from '../src/integrations/signnow'
import { mockProvider, __setMockOutcome } from '../src/integrations/signnow/mock.client'
import { SignNowError, type EnvelopeSigner, type FieldPlacement } from '../src/integrations/signnow/provider'
import { verifyWebhookSignature } from '../src/integrations/signnow/signnow.client'
import {
    apiErrorSchema,
    authErrorSchema,
    documentSchema,
    documentUploadSchema,
    inviteResponseSchema,
    userSchema,
    webhookEventSchema
} from '../src/integrations/signnow/schema'

const FIXTURES = join(__dirname, 'fixtures', 'signnow')

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

const SECRET = 'signing-test-secret-not-the-real-one'

const signer = (over: Partial<EnvelopeSigner> = {}): EnvelopeSigner => ({
    transactionPartyId: 'party-1',
    email: 'seller@example.test',
    fullLegalName: 'A Seller',
    order: 1,
    role: 'SELLER',
    ...over
})

const placement = (over: Partial<FieldPlacement> = {}): FieldPlacement => ({
    name: 'execution.seller1.signature',
    page: 5,
    bbox: [256.5, 707.64, 433.91, 715.64],
    kind: 'signature',
    pageHeight: 792,
    ...over
})

describe('signNow provider selection', () => {
    it('returns the mock provider when configured', () => {
        expect(signNowProvider().name).toEqual('mock')
    })
})

describe('webhook signature verification', () => {
    /**
     * The one that matters.
     *
     * signNow sends base64 of the **raw** sha256 digest. Their own PHP
     * reference is `base64_encode(hex2bin(hash_hmac(...)))`, which reads at a
     * glance like base64 of the hex string — and base64 of the hex string is a
     * perfectly plausible thing to write, is the same length class, and is
     * wrong. This test fails loudly if anyone ever "simplifies" it that way.
     *
     * Verified against real captured callbacks during the capture run: events
     * 04–07 in `test/fixtures/signnow/README.md` reported MATCHES.
     */
    it('accepts base64 of the raw digest, and rejects base64 of the hex string', () => {
        const body = Buffer.from(JSON.stringify({ meta: { event: 'x' } }))

        const hex = createHmac('sha256', SECRET).update(body).digest('hex')
        const rawDigestBase64 = Buffer.from(hex, 'hex').toString('base64')
        const hexStringBase64 = Buffer.from(hex, 'utf8').toString('base64')

        expect(verifyWebhookSignature(body, rawDigestBase64)).toBe(true)
        expect(verifyWebhookSignature(body, hexStringBase64)).toBe(false)
    })

    it('rejects a body that was re-serialised rather than kept as bytes', () => {
        // Whitespace differs, so the digest differs. This is why the webhook
        // route reads a raw Buffer instead of `req.body`.
        const original = Buffer.from('{"meta":{"event":"x"}}')
        const reserialised = Buffer.from(JSON.stringify(JSON.parse(original.toString())) + ' ')

        const signature = createHmac('sha256', SECRET).update(original).digest('base64')

        expect(verifyWebhookSignature(original, signature)).toBe(true)
        expect(verifyWebhookSignature(reserialised, signature)).toBe(false)
    })

    it('rejects a missing or malformed header without throwing', () => {
        const body = Buffer.from('{}')

        // `timingSafeEqual` throws on a length mismatch, and an uncaught throw
        // here becomes a 500 that signNow retries ten times.
        expect(verifyWebhookSignature(body, undefined)).toBe(false)
        expect(verifyWebhookSignature(body, '')).toBe(false)
        expect(verifyWebhookSignature(body, 'too-short')).toBe(false)
    })
})

describe('captured signNow responses still match the schemas', () => {
    it('parses the document upload', () => {
        const parsed = documentUploadSchema.parse(fixture('document-upload.json'))

        expect(parsed.id).toMatch(/^[a-f0-9]{40}$/)
    })

    it('parses a document, and finds the roles created by field placement', () => {
        const parsed = documentSchema.parse(fixture('document-get-with-fields.json'))

        expect(parsed.roles.map(role => role.name).sort()).toEqual(['Buyer', 'Seller'])

        // A string, not a number, and "1" for both roles — which is why the
        // invite's `order` is what sequences signing, not this.
        expect(parsed.roles.every(role => role.signing_order === '1')).toBe(true)
    })

    it('parses the invite response, which carries no ids at all', () => {
        expect(inviteResponseSchema.parse(fixture('document-invite.json'))).toEqual({ status: 'success' })
    })

    it('reads the sender address from primary_email, which is not called email', () => {
        const parsed = userSchema.parse(fixture('user-get.json'))

        expect(parsed.primary_email).toBeDefined()
        expect((parsed as unknown as { email?: string }).email).toBeUndefined()
    })

    it('parses both error envelopes, which share no field', () => {
        const auth = fixture('invalid-token.error.json') as { status: number; body: unknown }
        const api = fixture('document-invite.error.json') as { status: number; body: unknown }

        expect(auth.status).toEqual(400)
        expect(authErrorSchema.parse(auth.body).error).toEqual('invalid_token')

        // Same HTTP status, completely different shape.
        expect(api.status).toEqual(400)
        expect(apiErrorSchema.parse(api.body).errors[0]?.message).toEqual('Email is invalid')

        // Neither schema accepts the other's body.
        expect(authErrorSchema.safeParse(api.body).success).toBe(false)
        expect(apiErrorSchema.safeParse(auth.body).success).toBe(false)
    })

    it('parses every captured webhook, including the one with a different content shape', () => {
        const fieldInvite = webhookEventSchema.parse(fixture('webhook.04.user.document.fieldinvite.signed.json'))

        expect(fieldInvite.meta.event).toEqual('user.document.fieldinvite.signed')
        expect(fieldInvite.content.status).toEqual('fulfilled')
        expect(fieldInvite.content.invite_id).toBeDefined()

        // `document.complete` has no invite_id and no signer. `document_id` is
        // the only field common to both, which is what makes resolving an
        // envelope by externalId the only lookup that works for every event.
        const complete = webhookEventSchema.parse(fixture('webhook.07.user.document.complete.json'))

        expect(complete.meta.event).toEqual('user.document.complete')
        expect(complete.content.invite_id).toBeUndefined()
        expect(complete.content.document_id).toEqual(fieldInvite.content.document_id)
    })
})

describe('mock provider', () => {
    afterEach(() => {
        __setMockOutcome(null)
    })

    it('derives a document id from the PDF, so the same form gives the same id', async () => {
        const pdf = Buffer.from('a filled form')

        const first = await mockProvider.prepareDocument({
            documentName: 'OREA-100',
            pdf,
            signers: [signer()],
            placements: { 'party-1': [placement()] }
        })

        const second = await mockProvider.prepareDocument({
            documentName: 'OREA-100',
            pdf,
            signers: [signer()],
            placements: { 'party-1': [placement()] }
        })

        expect(first.externalId).toEqual(second.externalId)

        // Must survive being used as an S3 key segment at 3.4.
        expect(first.externalId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
    })

    it('refuses a signer with no fields placed, as the real vendor would', async () => {
        await expect(
            mockProvider.prepareDocument({
                documentName: 'OREA-100',
                pdf: Buffer.from('x'),
                signers: [signer()],
                placements: {}
            })
        ).rejects.toThrow(SignNowError)
    })

    it('can be made to fail with each kind', async () => {
        __setMockOutcome('unavailable')

        await expect(
            mockProvider.prepareDocument({
                documentName: 'OREA-100',
                pdf: Buffer.from('x'),
                signers: [signer()],
                placements: { 'party-1': [placement()] }
            })
        ).rejects.toMatchObject({ kind: 'unavailable' })
    })

    it('runs the real HMAC rather than pretending to verify', () => {
        const body = Buffer.from('{"meta":{"event":"x"}}')
        const signature = createHmac('sha256', SECRET).update(body).digest('base64')

        expect(mockProvider.verifyWebhookSignature(body, signature)).toBe(true)
        expect(mockProvider.verifyWebhookSignature(body, 'nope')).toBe(false)
    })
})
