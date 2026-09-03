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
 * A proposal, not a record. It is returned once, in the reply to the upload,
 * and nothing in it is believed until an agent confirms it: the corrected
 * values are what become a `Party` and an `IdentityRecord`. OCR is a head start
 * on typing, not an authority — and AnalyzeID is trained on US documents, so an
 * Ontario licence is read by a model that was never verified against one. Every
 * field here can be wrong or absent, including the ones that look certain.
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
            description:
                'The FINTRAC method used, and how the record was filled: `government_photo_id` when a reading assisted it, `government_photo_id_manual` when a person typed every value off the card. Both are the same method — the agent looked at a government photo ID either way — and the service decides which from what the reading produced, never the caller. Left as a string rather than an enum so that a value written by an older build cannot fail to parse on the way out.',
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

/**
 * The reply to an upload: an id, and what was read under it.
 *
 * Deliberately **not** an `IdentityRecord`. Uploading reads a document; it does
 * not verify anybody. The record appears when the agent confirms the reading,
 * which is what `POST .../identity/scans/{scanId}/confirm` is for.
 */
export const scanIdentityResponseSchema = registry.register(
    'ScanIdentityResponse',
    z.object({
        scanId: z.string().openapi({
            description:
                'Identifies this reading while it awaits confirmation. Confirming it is what creates the record.',
            example: 'clx4s5c6a7n8i9d0e1f2g3h4i'
        }),
        /*
         * A union rather than `.nullable()`. Calling `.nullable()` on a
         * registered schema emits the `$ref` wrapped in an `allOf` beside a
         * `type: [object, null]`, and `openapi-typescript` turns that into an
         * intersection — `ScannedIdentity & (Record<string, never> | null)` —
         * in which the null case is not expressible at all. The frontend would
         * then be typed as though this field is never null while the API
         * returns null, which is the one failure the generated pipeline exists
         * to prevent. A union emits `anyOf` and generates cleanly.
         */
        scanned: z.union([scannedIdentitySchema, z.null()]).openapi({
            description:
                'What the reader made of the image, or null when it could find no document in it. Null is not an error: the file is stored and the scan is confirmable, the agent simply types the document out instead of correcting a reading, and the record then says it was filled by hand.'
        })
    })
)

export type ScanIdentityResponse = z.infer<typeof scanIdentityResponseSchema>

/**
 * What the agent confirms.
 *
 * Only the two fields that live on the record and that a person can check
 * against the card in their hand. The name and address corrections go to the
 * `Party` through its own PATCH, because that is where they are used — the
 * OREA name blanks are filled from the party, not from a scan.
 *
 * The document number is deliberately not here, in either direction. It was
 * encrypted when it was read and it stays that way; there is no request in this
 * API that carries one, so there is no request that can log one.
 */
export const confirmIdentityScanRequestSchema = registry.register(
    'ConfirmIdentityScanRequest',
    z.object({
        documentType: identityDocumentTypeSchema.openapi({
            description: 'As confirmed by the agent, which may not be what was uploaded or read.'
        }),
        expiryDate: z.iso.date().nullable().openapi({
            description:
                'As confirmed by the agent. Null when the document has no expiry or none could be read and the agent left it blank.',
            example: '2029-04-17'
        })
    })
)

export type ConfirmIdentityScanRequest = z.infer<typeof confirmIdentityScanRequestSchema>

export const confirmIdentityScanResponseSchema = registry.register(
    'ConfirmIdentityScanResponse',
    z.object({ record: identityRecordSchema })
)

export type ConfirmIdentityScanResponse = z.infer<typeof confirmIdentityScanResponseSchema>

registry.registerPath({
    method: 'post',
    path: '/api/transactions/{id}/parties/{partyId}/identity',
    summary: 'Upload and read a party’s identity document',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. Multipart: `document` is the image and `documentType` says what it is. The file is stored in the Canadian bucket under SSE-KMS first and read from there, so the record is provably about the stored object. The document number is encrypted before it reaches a column and is never returned. **This does not verify anybody:** it answers with what was read and a `scanId`, and the `IdentityRecord` is created only when the agent confirms that reading. An image no document could be read from is not an error — it answers 201 with a null `scanned`, and the agent types the document out and confirms that.',
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
            description: 'What was read — or null when nothing could be — awaiting the agent’s confirmation',
            content: { 'application/json': { schema: scanIdentityResponseSchema } }
        },
        400: errorContent('No file, an unsupported type, or a document type that is not accepted'),
        401: errorContent('No session'),
        404: errorContent('No such transaction, or no such party on it'),
        502: errorContent('The document reader is unavailable')
    }
})

registry.registerPath({
    method: 'post',
    path: '/api/transactions/{id}/identity/scans',
    summary: 'Read an identity document before the party exists',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. The scan-first flow: an agent adding a party photographs the licence, and the reading fills the form that creates them — which has to happen in this order, because the name is the thing being read and it is also the one field a party cannot be created without. The scan is held with no party attached and becomes that person’s when it is confirmed through their party. Identical to the per-party scan in every other respect, including that it verifies nobody and that an image with no document in it answers 201 with a null `scanned`.',
    tags: ['identity'],
    request: {
        params: z.object({ id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }) }),
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
            description: 'What was read — or null when nothing could be — awaiting a party and a confirmation',
            content: { 'application/json': { schema: scanIdentityResponseSchema } }
        },
        400: errorContent('No file, an unsupported type, or a document type that is not accepted'),
        401: errorContent('No session'),
        404: errorContent('No such transaction'),
        502: errorContent('The document reader is unavailable')
    }
})

registry.registerPath({
    method: 'post',
    path: '/api/transactions/{id}/parties/{partyId}/identity/scans/{scanId}/confirm',
    summary: 'Confirm a reading, creating the identity record',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. The agent has read the document and checked it against the card; this writes the `IdentityRecord` from what they confirmed. Nothing is verified until this call — an uploaded scan that is never confirmed stays a reading. Confirming twice is a conflict rather than a second record: the reading is one event. A scan taken before the party existed is attached to the party here; one already attached to a different party on the same transaction is not confirmable through this one, and answers 404.',
    tags: ['identity'],
    request: {
        params: z.object({
            id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),
            partyId: z.string().openapi({ example: 'clx9z8y7x6w5v4u3t2s1r0q9p' }),
            scanId: z.string().openapi({ example: 'clx4s5c6a7n8i9d0e1f2g3h4i' })
        }),
        body: {
            required: true,
            content: {
                'application/json': { schema: confirmIdentityScanRequestSchema }
            }
        }
    },
    responses: {
        201: {
            description: 'The identity record the agent’s confirmation created',
            content: { 'application/json': { schema: confirmIdentityScanResponseSchema } }
        },
        400: errorContent('The confirmed values are not valid'),
        401: errorContent('No session'),
        404: errorContent('No such transaction or party, or no such scan available to this party'),
        409: errorContent('That scan has already been confirmed')
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
