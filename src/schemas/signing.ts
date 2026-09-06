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
        signers: z.array(envelopeSignerSchema),
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

export type SigningEnvelopeView = z.infer<typeof signingEnvelopeSchema>
export type EnvelopeStatus = z.infer<typeof envelopeStatusSchema>
export type SignerValidationFailure = z.infer<typeof signerValidationFailureSchema>
export type CreateEnvelopeRequest = z.infer<typeof createEnvelopeRequestSchema>

registry.registerPath({
    method: 'post',
    path: '/api/transactions/{id}/signing',
    summary: 'Send a filled form for signature',
    description: [
        'Runs the compliance gate, checks that every party can actually be invited, uploads the filled PDF to the e-sign provider with the signature fields placed on it, and invites the first signer.',
        '',
        'Signing is sequential: only the first signer is invited now. The provider invites the next one when the previous has signed, and every state change after this call arrives by webhook rather than from the browser.',
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
