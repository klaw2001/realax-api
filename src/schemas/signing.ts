import { registry, z } from '@/openapi/registry'
import { errorContent } from '@/schemas/common'
import { complianceResultSchema } from '@/schemas/compliance'
import { partyRoleSchema } from '@/schemas/party'

/**
 * Sending a filled form for signature (build plan 3.1).
 *
 * The envelope shape deliberately carries no email and no legal name. The
 * frontend already has the party list and joins by `transactionPartyId`, and
 * rule 6 keeps client names out of anything that ends up in a log or an error
 * body. Everything here is what *we* know about the envelope; the vendor's own
 * identifiers stay in `integrations/signnow`.
 */

export const envelopeStatusSchema = z
    .enum(['created', 'sent', 'signed', 'completed', 'declined', 'expired'])
    .openapi({
        description:
            'Moved by webhook, not by the browser. `created` means the document exists at the vendor but nobody has been invited yet — a state a Send can resume from.',
        example: 'sent'
    })

/**
 * How the signers were asked.
 *
 * `email` — signNow sends each signer its own hosted link, in turn. The signer
 * needs no access to REALAX and can be anywhere.
 *
 * `embedded` — nobody is emailed. The agent mints a short-lived signing link
 * per signer and renders it in the app, which is the in-person flow: the client
 * is sitting there and signs on the agent's device.
 *
 * Not a global setting. It is a property of one send, because the same agent
 * signs one deal across a desk and the next one across the province.
 */
export const envelopeDeliverySchema = registry.register(
    'EnvelopeDelivery',
    z.enum(['email', 'embedded']).openapi({
        description:
            '`email` sends each signer signNow\'s own hosted link in turn. `embedded` emails nobody — the agent mints a signing link per signer and renders it in the app, for a client who is physically present.',
        example: 'embedded'
    })
)

export const envelopeSignerSchema = registry.register(
    'EnvelopeSigner',
    z.object({
        transactionPartyId: z.string().openapi({
            description: 'Join to the party list for the name and contact details.',
            example: 'clx0a1b2c3d4e5f6g7h8i9j0k'
        }),
        role: partyRoleSchema,
        order: z.number().int().positive().openapi({
            description:
                'Position in the signing sequence. Dense from 1. Signer 2 is not invited until signer 1 has signed.',
            example: 1
        })
    })
)

export const signingEnvelopeSchema = registry.register(
    'SigningEnvelope',
    z.object({
        id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),
        transactionId: z.string().openapi({ example: 'clx9z8y7x6w5v4u3t2s1r0q9p' }),
        formCode: z.string().openapi({ example: '100' }),
        provider: z.string().openapi({ example: 'signnow' }),
        status: envelopeStatusSchema,
        delivery: envelopeDeliverySchema,
        signers: z.array(envelopeSignerSchema),
        awaitingTransactionPartyId: z
            .string()
            .nullable()
            .openapi({
                description:
                    'Whose turn it is, or null when nobody is being waited on. Derived from the signing events received so far, so it is what to render — but not what to trust before minting a link. The e-signature service decides that, and the link endpoint asks it.',
                example: 'clx0a1b2c3d4e5f6g7h8i9j0k'
            }),
        createdAt: z.iso.datetime().openapi({ example: '2026-09-04T16:32:21.000Z' }),
        updatedAt: z.iso.datetime().openapi({ example: '2026-09-04T16:40:02.000Z' })
    })
)

export const createEnvelopeRequestSchema = registry.register(
    'CreateEnvelopeRequest',
    z.object({
        formCode: z.string().min(1).openapi({
            description: 'A form already filled on this transaction. It is not filled for you.',
            example: '100'
        }),

        /*
         * Optional, defaulting to `email` — which is not the default the UI
         * offers. The two are different questions. An omitted field must not
         * silently change who receives an email about a contract, so the safe
         * answer on omission is the behaviour that existed before this field
         * did. A client that wants the in-person flow says so.
         */
        delivery: envelopeDeliverySchema.optional().default('email').openapi({
            description:
                'Omit for `email`, the long-standing behaviour. `embedded` sends nothing and requires the agent to mint a signing link per signer.',
            example: 'embedded'
        })
    })
)

export const envelopeResponseSchema = registry.register(
    'EnvelopeResponse',
    z.object({ envelope: signingEnvelopeSchema })
)

export const envelopeListResponseSchema = registry.register(
    'EnvelopeListResponse',
    z.object({ envelopes: z.array(signingEnvelopeSchema) })
)

/**
 * Why an envelope could not be raised for the parties as they stand.
 *
 * `field` names what to fix, never the value that is wrong. An address is a
 * client's contact detail and a name is a client's name; the frontend renders
 * both from `transactionPartyId`, which it already holds.
 */
export const signerValidationFailureSchema = registry.register(
    'SignerValidationFailure',
    z.object({
        transactionPartyId: z.string().nullable().openapi({
            description: 'Null when the problem is the party list as a whole rather than one party.',
            example: 'clx0a1b2c3d4e5f6g7h8i9j0k'
        }),
        role: partyRoleSchema.nullable(),
        field: z.enum(['parties', 'email', 'signingOrder']).openapi({ example: 'email' }),
        message: z.string().openapi({ example: 'This party has no email address' })
    })
)

export const signersIncompleteSchema = registry.register(
    'SignersIncompleteResponse',
    z.object({
        error: z.literal('signers_incomplete'),
        message: z.string(),
        signers: z.array(signerValidationFailureSchema)
    })
)

export const complianceFailedSchema = registry.register(
    'ComplianceFailedResponse',
    z.object({
        error: z.literal('compliance_failed'),
        message: z.string(),
        compliance: complianceResultSchema
    })
)

export const signingLinkRequestSchema = registry.register(
    'SigningLinkRequest',
    z.object({
        transactionPartyId: z.string().min(1).openapi({
            description: 'Which signer on the envelope is about to sign. Must be one of its `signers`.',
            example: 'clx0a1b2c3d4e5f6g7h8i9j0k'
        })
    })
)

/**
 * A link that signs the agreement.
 *
 * The nearest thing to this in the API is `FormDownloadResponse`, and the
 * difference is the point: that one grants a read of a document the agent
 * already has, this one grants the power to execute a contract as a named
 * client. It is a credential, not a location.
 */
export const signingLinkResponseSchema = registry.register(
    'SigningLinkResponse',
    z.object({
        url: z.string().openapi({
            description:
                'Authorises signing as that party — anyone who has it can sign, with no login. Render it into an iframe and let it go. Do not persist it, log it, put it in a bookmark, or pass it to a share sheet. It expires in minutes and a fresh one costs nothing, so there is never a reason to keep it.',
            example: 'https://app.signnow.com/webapp/document/…'
        }),
        expiresInSeconds: z.number().int().openapi({ example: 900 }),
        transactionPartyId: z.string().openapi({
            description: 'Echoed back, so a slow response cannot be rendered against the wrong signer.',
            example: 'clx0a1b2c3d4e5f6g7h8i9j0k'
        })
    })
)

export type SigningEnvelopeView = z.infer<typeof signingEnvelopeSchema>
export type EnvelopeStatus = z.infer<typeof envelopeStatusSchema>
export type EnvelopeDelivery = z.infer<typeof envelopeDeliverySchema>
export type SignerValidationFailure = z.infer<typeof signerValidationFailureSchema>
export type CreateEnvelopeRequest = z.infer<typeof createEnvelopeRequestSchema>
export type SigningLinkResponse = z.infer<typeof signingLinkResponseSchema>

registry.registerPath({
    method: 'post',
    path: '/api/transactions/{id}/signing',
    summary: 'Send a filled form for signature',
    description: [
        'Runs the compliance gate, checks that every party can actually be invited, uploads the filled PDF to the e-sign provider with the signature fields placed on it, and invites the first signer.',
        '',
        'Signing is sequential: only the first signer is invited now. The provider invites the next one when the previous has signed, and every state change after this call arrives by webhook rather than from the browser.',
        '',
        '`delivery` decides how they are asked. `email` is the default and sends each signer a hosted link in turn. `embedded` emails nobody at all — raise the envelope, then call the link endpoint per signer to get something to render in the app.',
        '',
        'At most one envelope per form may be out for signature at a time, enforced by a unique index rather than a check, so a double-clicked Send cannot produce two.'
    ].join('\n'),
    tags: ['signing'],
    security: [{ sessionCookie: [] }],
    request: {
        params: z.object({ id: z.string() }),
        body: {
            required: true,
            content: { 'application/json': { schema: createEnvelopeRequestSchema } }
        }
    },
    responses: {
        201: {
            description: 'The envelope was created and the first signer invited.',
            content: { 'application/json': { schema: envelopeResponseSchema } }
        },
        400: errorContent('The body is not a form code'),
        401: errorContent('No session'),
        404: errorContent('No such transaction, no curated template for that form, or the form has never been filled'),
        409: errorContent('This form already has an envelope out for signature'),
        422: {
            description:
                'The transaction is not ready. Either the compliance gate failed, or a party cannot be invited — the `error` field says which, and the matching key carries the detail.',
            content: {
                'application/json': {
                    schema: z.union([complianceFailedSchema, signersIncompleteSchema])
                }
            }
        },
        502: errorContent('The e-sign provider refused or could not be reached')
    }
})

registry.registerPath({
    method: 'get',
    path: '/api/transactions/{id}/signing',
    summary: 'The envelopes raised on a transaction',
    description: 'Newest first. Includes envelopes that were declined or expired, because "we sent this and they refused" is part of the record.',
    tags: ['signing'],
    security: [{ sessionCookie: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
        200: {
            description: 'The envelopes, newest first.',
            content: { 'application/json': { schema: envelopeListResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction')
    }
})

registry.registerPath({
    method: 'post',
    path: '/api/transactions/{id}/signing/{envelopeId}/link',
    summary: 'Mint a signing link for one signer',
    description: [
        'For an `embedded` envelope only: returns a short-lived URL that lets the named party sign, to be rendered in an iframe on the agent’s own device. Nothing is emailed.',
        '',
        'A POST rather than a GET because it is not idempotent — each call issues a fresh credential — and because a URL that signs a contract has no business in a browser history or a prefetch.',
        '',
        'Sequential signing is enforced by the e-signature service, not here: asking for signer 2 before signer 1 has finished answers 409. Mint on demand, immediately before handing the device over, rather than ahead of time.'
    ].join('\n'),
    tags: ['signing'],
    security: [{ sessionCookie: [] }],
    request: {
        params: z.object({ id: z.string(), envelopeId: z.string() }),
        body: {
            required: true,
            content: { 'application/json': { schema: signingLinkRequestSchema } }
        }
    },
    responses: {
        200: {
            description: 'The link. Render it and discard it.',
            content: { 'application/json': { schema: signingLinkResponseSchema } }
        },
        400: errorContent('The body does not name a party'),
        401: errorContent('No session'),
        404: errorContent('No such transaction or envelope, or that party is not on it'),
        409: errorContent(
            'The envelope was sent by email, or is already finished, or it is not that signer’s turn yet'
        ),
        502: errorContent('The e-sign provider refused or could not be reached')
    }
})
