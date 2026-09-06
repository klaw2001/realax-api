import './helpers/signNowMock'

import { createHmac } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import { signNowProvider } from '../src/integrations/signnow'
import { mockProvider, __setMockOutcome } from '../src/integrations/signnow/mock.client'
import {
    SignNowError,
    SIGNNOW_NOT_THIS_SIGNERS_TURN,
    type EnvelopeSigner,
    type FieldPlacement
} from '../src/integrations/signnow/provider'
import { verifyWebhookSignature } from '../src/integrations/signnow/signnow.client'
import {
    apiErrorSchema,
    authErrorSchema,
    documentSchema,
    documentUploadSchema,
    embeddedInviteCreateSchema,
    embeddedInviteLinkSchema,
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

    it('parses the embedded invite, which does carry per-signer ids', () => {
        const parsed = embeddedInviteCreateSchema.parse(fixture('embedded-invite-create.json'))

        expect(parsed.data).toHaveLength(2)
        expect(parsed.data.map(invite => invite.order)).toEqual([1, 2])

        // The whole reason 3.2 can show per-signer progress: these are the ids
        // the webhooks carry as `content.invite_id`. The email invite above
        // answers with nothing to correlate at all.
        expect(parsed.data.every(invite => /^[a-f0-9]{40}$/.test(invite.id))).toBe(true)

        // Only the first signer is asked. The second is created and waiting,
        // which is the vendor sequencing the run rather than us.
        expect(parsed.data[0]?.status).toEqual('pending')
        expect(parsed.data[1]?.status).toEqual('created')
    })

    it('parses the signing link', () => {
        const parsed = embeddedInviteLinkSchema.parse(fixture('embedded-invite-link.json'))

        expect(parsed.data.link).toBeDefined()
    })

    it('classifies every embedded refusal as rejected, and keeps the vendor code', () => {
        const cases = [
            { file: 'embedded-invite-create.error.json', status: 400, code: 19003008 },
            { file: 'embedded-invite-link-order2.error.json', status: 403, code: SIGNNOW_NOT_THIS_SIGNERS_TURN },
            { file: 'embedded-invite-link.error.json', status: 404, code: 19002002 }
        ]

        for (const expected of cases) {
            const captured = fixture(expected.file) as { status: number; body: unknown }

            expect(captured.status).toEqual(expected.status)

            // All three are the API-layer envelope, so `classify()` needed no
            // widening for embedded signing — they are `rejected`, not
            // `misconfigured`, because the vendor understood us and said no.
            const parsed = apiErrorSchema.parse(captured.body)

            expect(parsed.errors[0]?.code).toEqual(expected.code)
            expect(authErrorSchema.safeParse(captured.body).success).toBe(false)
        }
    })

    /*
     * Finding 24. The guess going in was that `fieldinvite.sent` would not fire
     * for a delivery that sends nothing, which would have meant an
     * embedded-specific branch in `STATUS_FOR_EVENT`. It fires, so there is no
     * branch — and this test is what would catch the vendor changing its mind.
     */
    it('sends the same webhooks for an embedded signature, carrying our own invite ids', () => {
        const sent = webhookEventSchema.parse(
            fixture('webhook.embedded.01.user.document.fieldinvite.sent.json')
        )
        const signed = webhookEventSchema.parse(
            fixture('webhook.embedded.02.user.document.fieldinvite.signed.json')
        )

        expect(sent.meta.event).toEqual('user.document.fieldinvite.sent')
        expect(signed.meta.event).toEqual('user.document.fieldinvite.signed')

        // The ids the create call handed back, come home again. This is what
        // makes per-signer progress possible on the embedded path and
        // impossible on the email one, where the invite returns nothing.
        expect(sent.content.invite_id).toMatch(/^[a-f0-9]{40}$/)
        expect(signed.content.invite_id).toMatch(/^[a-f0-9]{40}$/)
        expect(sent.content.invite_id).not.toEqual(signed.content.invite_id)

        // One signature produced both: signer 1 finishing, and signNow asking
        // signer 2 without being told to.
        expect(sent.content.document_id).toEqual(signed.content.document_id)
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

    it('derives invite ids the same way, so a resume can be told from a re-invite', async () => {
        const roleIds = { 'party-1': 'b'.repeat(40) }

        const first = await mockProvider.inviteSignersEmbedded('a'.repeat(40), {
            signers: [signer()],
            roleIds
        })

        const second = await mockProvider.inviteSignersEmbedded('a'.repeat(40), {
            signers: [signer()],
            roleIds
        })

        expect(first.invited[0]?.externalInviteId).toEqual(second.invited[0]?.externalInviteId)
        expect(first.invited[0]?.externalInviteId).toMatch(/^[a-f0-9]{40}$/)
    })

    it('refuses a signer with no role, as the real vendor would', async () => {
        await expect(
            mockProvider.inviteSignersEmbedded('a'.repeat(40), { signers: [signer()], roleIds: {} })
        ).rejects.toMatchObject({ kind: 'rejected' })
    })

    /*
     * This test exists to fail when somebody "improves" the mock into something
     * realistic. A link that looks real is one a developer will eventually click
     * and then trust, and `.invalid` is reserved by RFC 2606 precisely so it
     * cannot resolve. Do not relax it.
     */
    it('mints a link that is obviously not a real one', async () => {
        const link = await mockProvider.embeddedSigningLink('a'.repeat(40), 'c'.repeat(40))

        expect(new URL(link.url).hostname.endsWith('.invalid')).toBe(true)
        expect(link.url).not.toContain('signnow')
        expect(link.expiresInSeconds).toBeGreaterThan(0)
    })

    it('can be made to fail with each kind, on the embedded methods too', async () => {
        for (const kind of ['unavailable', 'misconfigured', 'rejected', 'schema'] as const) {
            __setMockOutcome(kind)

            await expect(
                mockProvider.inviteSignersEmbedded('a'.repeat(40), {
                    signers: [signer()],
                    roleIds: { 'party-1': 'b'.repeat(40) }
                })
            ).rejects.toMatchObject({ kind })

            await expect(
                mockProvider.embeddedSigningLink('a'.repeat(40), 'c'.repeat(40))
            ).rejects.toMatchObject({ kind })
        }
    })

    it('runs the real HMAC rather than pretending to verify', () => {
        const body = Buffer.from('{"meta":{"event":"x"}}')
        const signature = createHmac('sha256', SECRET).update(body).digest('base64')

        expect(mockProvider.verifyWebhookSignature(body, signature)).toBe(true)
        expect(mockProvider.verifyWebhookSignature(body, 'nope')).toBe(false)
    })
})
