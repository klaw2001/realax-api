/**
 * signNow response shapes, built from captured responses.
 *
 * CLAUDE.md rule 2: never invent an external API response shape. Every schema
 * here is derived from a file in `test/fixtures/signnow/`, and
 * `test/signnow-provider.test.ts` parses those fixtures through these schemas
 * so a vendor change breaks a test rather than a transaction.
 *
 * Plain `zod` here, not `@/openapi/registry`. These shapes are signNow's, not
 * ours; nothing here belongs in `openapi.json` for the frontend to generate
 * types from.
 *
 * Every schema is deliberately loose about fields we do not read. signNow
 * returns forty-odd keys on a document and adds more over time; pinning all of
 * them would turn a vendor adding a feature into an outage.
 */

import { z } from 'zod'

/**
 * A signNow id: 40 lowercase hex characters.
 *
 * Pinned rather than left as `string` because these ids become S3 key segments
 * in `keys.auditTrail()` at 3.4, where `SAFE_SEGMENT`
 * (`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`) throws on a dot or a slash. Catching a
 * hostile id here means failing before an envelope exists; catching it at
 * completion means failing after a contract has been signed.
 */
export const signNowIdSchema = z.string().regex(/^[a-f0-9]{40}$/, 'expected a 40-character signNow id')

/** `POST /document` — the upload answers with the id and nothing else. */
export const documentUploadSchema = z.object({
    id: signNowIdSchema
})

/**
 * One role on a document.
 *
 * `signing_order` is a **string**, not a number, and defaults to "1" for every
 * role regardless of the order fields were placed in. It is not what sequences
 * signing — the invite's `order` is — so it is parsed and ignored.
 */
export const documentRoleSchema = z.object({
    unique_id: signNowIdSchema,
    name: z.string().min(1),
    signing_order: z.string().optional()
})

/**
 * `GET /document/{id}`, as much of it as we read.
 *
 * `roles` is the point: signNow creates them implicitly from the `role` name on
 * each placed field, so the ids have to be read back rather than assumed.
 */
export const documentSchema = z.object({
    id: signNowIdSchema,
    roles: z.array(documentRoleSchema),
    // Present but unused; carried so a document with no fields is
    // distinguishable from one whose fields failed to place.
    fields: z.array(z.unknown()).optional()
})

/**
 * `POST /document/{id}/invite`.
 *
 * This really is the whole response. No invite id, no signer ids, nothing to
 * correlate with — which is why per-signer identifiers come from the webhook
 * events instead.
 */
export const inviteResponseSchema = z.object({
    status: z.literal('success')
})

/** `GET /user`, cut to the two fields an invite's `from` needs. */
export const userSchema = z.object({
    id: signNowIdSchema,
    primary_email: z.email().optional(),
    emails: z.array(z.string()).optional()
})

/**
 * The two error envelopes.
 *
 * signNow uses both, and they share no field. The auth layer answers
 * `{"error": "invalid_token", "code": 1537}`; the API layer answers
 * `{"errors": [{"code": 65585, "message": "Email is invalid"}]}`. A client that
 * parses one reads `undefined` from the other and reports every failure of that
 * class as "unknown error". Both arrive as HTTP 400.
 */
export const authErrorSchema = z.object({
    error: z.string(),
    code: z.number().optional()
})

export const apiErrorSchema = z.object({
    errors: z.array(
        z.object({
            code: z.number().optional(),
            message: z.string()
        })
    )
})

/**
 * A webhook callback.
 *
 * Nested under `meta` and `content` — there is no top-level `event`. Only the
 * two fields the handler acts on are required:
 *
 *   `meta.event`          which state the envelope moves to
 *   `content.document_id` which envelope it is
 *
 * Everything else is optional on purpose. `user.document.complete` carries a
 * different content shape from the fieldinvite events — no `invite_id`, no
 * `signer` — and `user.invite.expired` has never been captured at all, because
 * it needs an expiry to elapse. A strict schema would reject the event types we
 * have not seen, rejecting means a 4xx, and 30 of those in an hour costs us the
 * subscription. The whole body is stored in `SignerEvent.payload` regardless.
 */
export const webhookEventSchema = z.object({
    meta: z.object({
        event: z.string().min(1),
        timestamp: z.number().optional()
    }),
    content: z.object({
        document_id: signNowIdSchema,
        invite_id: z.string().optional(),
        signer: z.string().optional(),
        status: z.string().optional()
    })
})

export type DocumentUpload = z.infer<typeof documentUploadSchema>
export type SignNowDocument = z.infer<typeof documentSchema>
export type SignNowUser = z.infer<typeof userSchema>
export type WebhookEvent = z.infer<typeof webhookEventSchema>
