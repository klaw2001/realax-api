import { registry, z } from '@/openapi/registry'
import { errorContent } from '@/schemas/common'

/**
 * Identity documents (build plan 2.5).
 *
 * FINTRAC material: five-year retention, Object Lock on the object, presigned
 * reads only, never public.
 *
 * The one rule that shapes every type below: **the document number never leaves
 * the service.** It is encrypted before it reaches its column and it is not in
 * any response here — not masked, not truncated, not last-four. The agent
 * looked at the card; the record exists to prove the check happened, not to be
 * a copy of the card. `documentNumberOnFile` says whether there is one, which
 * is the only question a screen actually asks.
 */

export const identityDocumentTypeSchema = registry.register(
    'IdentityDocumentType',
    z.enum(['drivers_licence', 'passport']).openapi({
        description:
            'Narrow on purpose: FINTRAC names particular documents, and a scan of something else is not a verification however well it reads.',
        example: 'drivers_licence'
    })
)

export type IdentityDocumentType = z.infer<typeof identityDocumentTypeSchema>

/**
 * What a scan read, for the agent to confirm.
 *
 * Returned once, in the reply to the upload, and never stored in this shape —
 * the agent corrects it and the corrected values are what become a `Party` and
 * an `IdentityRecord`. OCR is a head start on typing, not an authority.
 */
export const scannedIdentitySchema = registry.register(
    'ScannedIdentity',
    z.object({
        documentType: identityDocumentTypeSchema.nullable(),
        fullName: z.string().nullable().openapi({ example: 'MARGARET ANNE WHITFIELD' }),
        firstName: z.string().nullable(),
        middleName: z.string().nullable(),
        lastName: z.string().nullable(),
        dateOfBirth: z.iso.date().nullable().openapi({ example: '1979-04-17' }),
        expiryDate: z.iso.date().nullable().openapi({ example: '2029-04-17' }),
        address: z.string().nullable(),
        city: z.string().nullable(),
        province: z.string().nullable(),
        postalCode: z.string().nullable(),

        // Deliberately absent: documentNumber. It is read, encrypted and
        // stored, and it is not sent back — a value in a response is a value in
        // a browser's memory, a proxy log and a developer's network tab.
        documentNumberRead: z.boolean().openapi({
            description:
                'Whether a document number was read. The number itself is never returned; it is encrypted at rest and stays server-side.',
            example: true
        }),

        confidence: z.number().openapi({
            description:
                'The lowest confidence across the fields that were found, 0–100. The lowest rather than the mean, because a result where everything is certain except the document number is exactly the result to check.',
            example: 96.4
        }),

        lowConfidence: z.boolean().openapi({
            description: 'Below the threshold at which the agent should read every field rather than skim.',
            example: false
        })
    })
)

export type ScannedIdentity = z.infer<typeof scannedIdentitySchema>

export const identityRecordSchema = registry.register(
    'IdentityRecord',
    z.object({
        id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),
        partyId: z.string().openapi({
            description: 'The person this verifies, not the party-on-a-transaction row.',
            example: 'clx9z8y7x6w5v4u3t2s1r0q9p'
        }),
        documentType: identityDocumentTypeSchema,

        documentNumberOnFile: z.boolean().openapi({
            description:
                'Whether a document number is held. The number is encrypted at rest and is never returned by this API, in any form.',
            example: true
        }),

        expiryDate: z.iso.date().nullable().openapi({ example: '2029-04-17' }),
        verifiedAt: z.iso.datetime().openapi({ example: '2026-09-02T09:00:00.000Z' }),
        verifiedMethod: z.string().openapi({
            description: 'The FINTRAC method used.',
            example: 'government_photo_id'
        }),
        expired: z.boolean().openapi({
            description: 'The document had expired as of this reading. A verification on an expired document is not one.',
            example: false
        })
    })
)

export type IdentityRecord = z.infer<typeof identityRecordSchema>

export const identityRecordListResponseSchema = registry.register(
    'IdentityRecordListResponse',
    z.object({ records: z.array(identityRecordSchema) })
)

export type IdentityRecordListResponse = z.infer<typeof identityRecordListResponseSchema>

export const scanIdentityResponseSchema = registry.register(
    'ScanIdentityResponse',
    z.object({
        scanned: scannedIdentitySchema,
        record: identityRecordSchema
    })
)

export type ScanIdentityResponse = z.infer<typeof scanIdentityResponseSchema>

registry.registerPath({
    method: 'post',
    path: '/api/transactions/{id}/parties/{partyId}/identity',
    summary: 'Upload and read a party’s identity document',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. Multipart: `document` is the image and `documentType` says what it is. The file is stored in the Canadian bucket under SSE-KMS first and read from there, so the record is provably about the stored object. The document number is encrypted before it reaches a column and is never returned.',
    tags: ['identity'],
    request: {
        params: z.object({
            id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),
            partyId: z.string().openapi({ example: 'clx9z8y7x6w5v4u3t2s1r0q9p' })
        }),
        body: {
            required: true,
            content: {
                'multipart/form-data': {
                    schema: z.object({
                        document: z.string().openapi({
                            type: 'string',
                            format: 'binary',
                            description: 'JPEG or PNG, at most 5 MB.'
                        }),
                        documentType: identityDocumentTypeSchema
                    })
                }
            }
        }
    },
    responses: {
        201: {
            description: 'What was read, and the record it created',
            content: { 'application/json': { schema: scanIdentityResponseSchema } }
        },
        400: errorContent('No file, an unsupported type, or a document type that is not accepted'),
        401: errorContent('No session'),
        404: errorContent('No such transaction, or no such party on it'),
        422: errorContent('The image was stored but no identity document could be read from it'),
        502: errorContent('The document reader is unavailable')
    }
})

registry.registerPath({
    method: 'get',
    path: '/api/transactions/{id}/parties/{partyId}/identity',
    summary: 'The identity records held for a party',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. Records are held against the person, so a party verified on an earlier transaction is already verified here — that reuse is the point of build plan 2.5. Document numbers are never included.',
    tags: ['identity'],
    request: {
        params: z.object({
            id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),
            partyId: z.string().openapi({ example: 'clx9z8y7x6w5v4u3t2s1r0q9p' })
        })
    },
    responses: {
        200: {
            description: 'The records held, newest first',
            content: { 'application/json': { schema: identityRecordListResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction, or no such party on it')
    }
})
