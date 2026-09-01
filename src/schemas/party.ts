import { registry, z } from '@/openapi/registry'
import { errorContent } from '@/schemas/common'

/**
 * Parties — the people on a transaction (build plan 1.5).
 *
 * A party is addressed as a person *on a transaction*, not as a free-standing
 * person: `id` below identifies the pairing, and `personId` the underlying
 * record. Phase 2.5 reuses one person across deals by pointing a second pairing
 * at the same `personId`, so the contract names both from the start rather than
 * changing shape when that lands.
 *
 * The identity fields — address, date of birth — are the ones an Ontario
 * driver's licence yields that an OREA form or a FINTRAC check consumes. They
 * are typed in today. Phase 2.5 fills the same fields from an OCR'd scan, which
 * is why they exist now: the vendor decision does not change the field set.
 *
 * The licence number and its expiry are deliberately not here. Those are
 * identity documents rather than party details — FINTRAC material with a
 * five-year retention and encryption at rest — and they belong to
 * `IdentityRecord`, written only by the verification flow.
 */

/**
 * The roles a person can hold. Fixed by the data model in build plan 0.2.
 *
 * `SPOUSE` and `WITNESS` are here because OREA forms have blanks for them —
 * spousal consent and a witness to a signature. Whether a party can be a
 * *representative* of a buyer or seller is an open question; see NEEDS-KLAW.
 */
export const partyRoleSchema = registry.register(
    'PartyRole',
    z.enum(['BUYER', 'SELLER', 'SPOUSE', 'WITNESS']).openapi({ example: 'SELLER' })
)

export type PartyRole = z.infer<typeof partyRoleSchema>

/**
 * A date on a document, not an instant.
 *
 * Stored in a Postgres `DATE` column and carried as `YYYY-MM-DD`, so a birth
 * date read back in another timezone is still the date printed on the licence.
 */
const dateOnly = z.iso.date()

export const partySchema = registry.register(
    'Party',
    z.object({
        id: z.string().openapi({
            description:
                'Identifies this party on this transaction. Use it for the item routes under /api/transactions/{id}/parties.',
            example: 'clx0a1b2c3d4e5f6g7h8i9j0k'
        }),
        personId: z.string().openapi({
            description:
                'The underlying person record. Distinct from `id` because build plan 2.5 reuses one person across transactions; today there is exactly one party per person.',
            example: 'clx9z8y7x6w5v4u3t2s1r0q9p'
        }),
        role: partyRoleSchema,
        signingOrder: z.number().int().nullable().openapi({
            description:
                'Position in the signing sequence (build plan 3.1 signs one signer at a time). Null until the order is set.',
            example: 1
        }),

        fullLegalName: z.string().openapi({ example: 'Margaret Anne Chen' }),
        email: z.string().nullable().openapi({ example: 'm.chen@example.com' }),
        phone: z.string().nullable().openapi({ example: '416-555-0142' }),

        // The address block mirrors `Property` field for field, so the mapper in
        // build plan 2.2 handles one address shape rather than two.
        address: z.string().nullable().openapi({ example: '88 Wellesley St E' }),
        city: z.string().nullable().openapi({ example: 'Toronto' }),
        province: z.string().nullable().openapi({ example: 'ON' }),
        postalCode: z.string().nullable().openapi({ example: 'M4Y 1H1' }),

        dateOfBirth: dateOnly.nullable().openapi({
            description: 'As printed on the identity document. Date only — no time, no timezone.',
            example: '1979-04-17'
        }),

        createdAt: z.iso.datetime().openapi({ example: '2026-09-02T09:00:00.000Z' }),
        updatedAt: z.iso.datetime().openapi({ example: '2026-09-02T09:00:00.000Z' })
    })
)

export type Party = z.infer<typeof partySchema>

export const partyResponseSchema = registry.register(
    'PartyResponse',
    z.object({
        party: partySchema
    })
)

export type PartyResponse = z.infer<typeof partyResponseSchema>

export const partyListResponseSchema = registry.register(
    'PartyListResponse',
    z.object({
        parties: z.array(partySchema)
    })
)

export type PartyListResponse = z.infer<typeof partyListResponseSchema>

/** Optional free text on a party. Trimmed, bounded, and clearable with null. */
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullish()

/**
 * A birth date that could belong to a living person.
 *
 * Bounded rather than merely well-formed, because a typo in a year is the one
 * OCR and keyboard error that a date parser accepts silently. No minimum age is
 * enforced: a minor on title with a guardian is unusual but real, and refusing
 * to record one would block a legitimate deal.
 */
const birthDate = dateOnly.refine(
    value => {
        const parsed = Date.parse(`${value}T00:00:00.000Z`)

        return parsed > Date.parse('1900-01-01T00:00:00.000Z') && parsed <= Date.now()
    },
    { message: 'Date of birth must be a past date after 1900' }
)

/**
 * Add a party to a transaction.
 *
 * Only the name and the role are required. Everything else is legitimately
 * unknown when a listing is being set up — an agent adds the sellers long before
 * anyone has seen a piece of identification, and a form that demanded a date of
 * birth up front would be filled with placeholders.
 */
export const createPartyRequestSchema = registry.register(
    'CreatePartyRequest',
    z.object({
        role: partyRoleSchema,
        fullLegalName: z.string().trim().min(1).max(200).openapi({
            description:
                'The name as it appears on identification and as it will be filled on the form.',
            example: 'Margaret Anne Chen'
        }),

        // Bounded and format-checked, but optional: an email is how a signing
        // invite reaches this person in build plan 3.1, not something known now.
        email: z.email().max(320).nullish().openapi({ example: 'm.chen@example.com' }),
        phone: optionalText(32).openapi({ example: '416-555-0142' }),

        address: optionalText(200).openapi({ example: '88 Wellesley St E' }),
        city: optionalText(120).openapi({ example: 'Toronto' }),
        province: optionalText(32).openapi({ example: 'ON' }),
        postalCode: optionalText(16).openapi({ example: 'M4Y 1H1' }),

        dateOfBirth: birthDate.nullish().openapi({ example: '1979-04-17' }),

        signingOrder: z.number().int().min(1).max(50).nullish().openapi({
            description: 'Position in the signing sequence. Left null until the order is decided.',
            example: 1
        })
    })
)

export type CreatePartyRequest = z.infer<typeof createPartyRequestSchema>

/**
 * Edit a party.
 *
 * A PATCH, not a PUT: the identity fields arrive at different times and from
 * different places — a name typed during setup, an address read off a licence
 * later — and a whole-object write would let the second one blank what the first
 * one established. An absent key is unchanged; an explicit null clears.
 *
 * `role` is nullable-free because a party without a role is not on the
 * transaction. Moving someone from BUYER to SELLER is a legitimate correction,
 * so the field itself is editable.
 */
export const updatePartyRequestSchema = registry.register(
    'UpdatePartyRequest',
    z.object({
        role: partyRoleSchema.optional(),
        fullLegalName: z.string().trim().min(1).max(200).optional().openapi({
            example: 'Margaret Anne Chen'
        }),
        email: z.email().max(320).nullish().openapi({ example: 'm.chen@example.com' }),
        phone: optionalText(32).openapi({ example: '416-555-0142' }),
        address: optionalText(200).openapi({ example: '88 Wellesley St E' }),
        city: optionalText(120).openapi({ example: 'Toronto' }),
        province: optionalText(32).openapi({ example: 'ON' }),
        postalCode: optionalText(16).openapi({ example: 'M4Y 1H1' }),
        dateOfBirth: birthDate.nullish().openapi({ example: '1979-04-17' }),
        signingOrder: z.number().int().min(1).max(50).nullish().openapi({ example: 1 })
    })
)

export type UpdatePartyRequest = z.infer<typeof updatePartyRequestSchema>

/**
 * The answer to a delete. Mirrors the logout response: a literal rather than an
 * empty 204, so the generated frontend client has a body to check.
 */
export const deletePartyResponseSchema = registry.register(
    'DeletePartyResponse',
    z.object({
        deleted: z.literal(true).openapi({ example: true })
    })
)

export type DeletePartyResponse = z.infer<typeof deletePartyResponseSchema>

const transactionIdParam = z.object({
    id: z.string().openapi({
        description: 'The transaction. Must belong to the caller.',
        example: 'clx0a1b2c3d4e5f6g7h8i9j0k'
    })
})

const partyIdParam = transactionIdParam.extend({
    partyId: z.string().openapi({
        description: "The party's `id` — the one from the list response, not `personId`.",
        example: 'clx0a1b2c3d4e5f6g7h8i9j0k'
    })
})

registry.registerPath({
    method: 'get',
    path: '/api/transactions/{id}/parties',
    summary: 'The parties on a transaction',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. Ordered by signing order, then by when each party was added; parties with no signing order come last. Removed parties are absent. A transaction someone else owns answers 404, the same as one that does not exist.',
    tags: ['parties'],
    request: { params: transactionIdParam },
    responses: {
        200: {
            description: 'The parties on the transaction',
            content: { 'application/json': { schema: partyListResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction')
    }
})

registry.registerPath({
    method: 'post',
    path: '/api/transactions/{id}/parties',
    summary: 'Add a party to a transaction',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. Creates a new person record and places them on the transaction. There is no way to attach an existing person yet — see build plan 2.5.',
    tags: ['parties'],
    request: {
        params: transactionIdParam,
        body: {
            required: true,
            content: { 'application/json': { schema: createPartyRequestSchema } }
        }
    },
    responses: {
        201: {
            description: 'The party as saved',
            content: { 'application/json': { schema: partyResponseSchema } }
        },
        400: errorContent('Body failed validation'),
        401: errorContent('No session'),
        404: errorContent('No such transaction')
    }
})

registry.registerPath({
    method: 'get',
    path: '/api/transactions/{id}/parties/{partyId}',
    summary: 'One party on a transaction',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. A removed party answers 404.',
    tags: ['parties'],
    request: { params: partyIdParam },
    responses: {
        200: {
            description: 'The party',
            content: { 'application/json': { schema: partyResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction, or no such party on it')
    }
})

registry.registerPath({
    method: 'patch',
    path: '/api/transactions/{id}/parties/{partyId}',
    summary: 'Edit a party',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. Partial: an absent field is unchanged, an explicit null clears it. Returns the saved party, so the client renders what was stored rather than what it sent.',
    tags: ['parties'],
    request: {
        params: partyIdParam,
        body: {
            required: true,
            content: { 'application/json': { schema: updatePartyRequestSchema } }
        }
    },
    responses: {
        200: {
            description: 'The saved party',
            content: { 'application/json': { schema: partyResponseSchema } }
        },
        400: errorContent('Body failed validation'),
        401: errorContent('No session'),
        404: errorContent('No such transaction, or no such party on it')
    }
})

registry.registerPath({
    method: 'delete',
    path: '/api/transactions/{id}/parties/{partyId}',
    summary: 'Remove a party from a transaction',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. A soft delete: the party stops appearing on this transaction, and the person record is left intact because the same person may be on another transaction and their identity records are retained regardless. Removing an already-removed party answers 404.',
    tags: ['parties'],
    request: { params: partyIdParam },
    responses: {
        200: {
            description: 'The party was removed from the transaction',
            content: { 'application/json': { schema: deletePartyResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction, or no such party on it')
    }
})
