import { registry, z } from '@/openapi/registry'
import { errorContent } from '@/schemas/common'

/**
 * Property — the OREA-relevant facts about the address a transaction is about.
 *
 * The field set is the one Form 100 needs filled, not everything MLS knows:
 * frontage, depth and the legal description are blanks on the form, and the
 * bedroom count is not. MLS is where these values start; every one of them is
 * editable afterwards, because the listing data is a draft and the agent is the
 * one who signs.
 */

const addressField = z.string().trim().min(1).max(200)
const cityField = z.string().trim().min(1).max(120)

/** Optional free text on a property. Trimmed, bounded, and clearable with null. */
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullish()

/**
 * The saved property.
 *
 * `province` defaults to ON rather than being required: this is an Ontario
 * product, and the sandbox MLS key returns US listings whose state would
 * otherwise have to be corrected on every single autofill.
 */
export const propertySchema = registry.register(
    'Property',
    z.object({
        id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),
        mlsNumber: z.string().nullable().openapi({ example: 'C5839471' }),
        address: z.string().openapi({ example: '7913 Eudora LN' }),
        city: z.string().openapi({ example: 'Toronto' }),
        province: z.string().openapi({ example: 'ON' }),
        postalCode: z.string().nullable().openapi({ example: 'M5V 2T6' }),

        // The OREA "fronting on the ___ side of ___" pair. No MLS field maps to
        // the side, so it arrives blank from autofill and is typed in.
        frontingSide: z.string().nullable().openapi({ example: 'North' }),
        frontingStreet: z.string().nullable().openapi({ example: 'Eudora Lane' }),

        // Strings, not numbers: OREA frontage and depth are written as they are
        // measured ("49.21 feet", "irregular"), and rounding them into a number
        // would put a wrong figure on a signed document.
        frontage: z.string().nullable().openapi({ example: '49.21 feet' }),
        depth: z.string().nullable().openapi({ example: '120 feet' }),

        legalDescription: z.string().nullable().openapi({ example: 'LOT 7 BLK G PLAN 66M-1234' }),
        listPrice: z.number().int().nullable().openapi({ example: 369000 }),
        taxes: z.string().nullable().openapi({ example: '4,231.00' })
    })
)

export type Property = z.infer<typeof propertySchema>

export const propertyResponseSchema = registry.register(
    'PropertyResponse',
    z.object({
        property: propertySchema
    })
)

export type PropertyResponse = z.infer<typeof propertyResponseSchema>

/**
 * A property as MLS describes it, before anything is saved.
 *
 * Identical to `Property` minus the id, because nothing has been persisted yet.
 * The frontend fills its form from this and the agent edits it; what comes back
 * on save is the `Property`.
 */
export const propertyDraftSchema = registry.register(
    'PropertyDraft',
    propertySchema.omit({ id: true })
)

export type PropertyDraft = z.infer<typeof propertyDraftSchema>

export const propertyDraftResponseSchema = registry.register(
    'PropertyDraftResponse',
    z.object({
        property: propertyDraftSchema
    })
)

export type PropertyDraftResponse = z.infer<typeof propertyDraftResponseSchema>

/**
 * One row in the search dropdown. Deliberately small — enough to tell two
 * listings on the same street apart, and nothing more. The full draft is
 * fetched when a row is picked, which is a cached call by MLS number.
 */
export const propertySearchResultSchema = registry.register(
    'PropertySearchResult',
    z.object({
        mlsNumber: z.string().openapi({ example: 'C5839471' }),
        address: z.string().openapi({ example: '7913 Eudora LN' }),
        city: z.string().openapi({ example: 'Austin' }),
        province: z.string().openapi({ example: 'TX' }),
        listPrice: z.number().int().nullable().openapi({ example: 369000 }),
        propertyType: z.string().nullable().openapi({ example: 'Residential' })
    })
)

export type PropertySearchResult = z.infer<typeof propertySearchResultSchema>

export const propertySearchResponseSchema = registry.register(
    'PropertySearchResponse',
    z.object({
        results: z.array(propertySearchResultSchema),

        // The upstream total across all pages, not `results.length`. Shown as
        // "10 of 42,886" rather than implying the board holds ten listings.
        count: z.number().int().openapi({ example: 42886 })
    })
)

export type PropertySearchResponse = z.infer<typeof propertySearchResponseSchema>

/**
 * Save the property on a transaction.
 *
 * A PUT, not a PATCH: the client holds the whole form and sends all of it, so
 * an omitted optional field means the agent cleared it. Only address and city
 * are required — a property with neither cannot be identified on a form, while
 * everything else is legitimately unknown at this stage of a listing.
 */
export const savePropertyRequestSchema = registry.register(
    'SavePropertyRequest',
    z.object({
        mlsNumber: optionalText(32).openapi({
            description: 'The listing this was autofilled from, when it was autofilled at all.',
            example: 'C5839471'
        }),
        address: addressField.openapi({ example: '7913 Eudora LN' }),
        city: cityField.openapi({ example: 'Toronto' }),
        province: z.string().trim().min(1).max(32).default('ON').openapi({ example: 'ON' }),
        postalCode: optionalText(16).openapi({ example: 'M5V 2T6' }),
        frontingSide: optionalText(32).openapi({ example: 'North' }),
        frontingStreet: optionalText(200).openapi({ example: 'Eudora Lane' }),
        frontage: optionalText(64).openapi({ example: '49.21 feet' }),
        depth: optionalText(64).openapi({ example: '120 feet' }),
        legalDescription: optionalText(1000).openapi({ example: 'LOT 7 BLK G PLAN 66M-1234' }),

        // Bounded above at a billion so a stray keystroke cannot store a price
        // that Postgres refuses as an integer overflow at write time.
        listPrice: z.number().int().min(0).max(1_000_000_000).nullish().openapi({ example: 369000 }),
        taxes: optionalText(64).openapi({ example: '4,231.00' })
    })
)

export type SavePropertyRequest = z.infer<typeof savePropertyRequestSchema>

registry.registerPath({
    method: 'get',
    path: '/api/properties/search',
    summary: 'Search MLS listings by address or MLS number',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session. Proxies Repliers — the key is server-side only. An entry matching an MLS number pattern is routed to the detail endpoint and returns at most one result. Results are cached for 24 hours; Repliers bills per request.',
    tags: ['properties'],
    request: {
        query: z.object({
            q: z.string().openapi({
                description: 'Address text or an MLS number. Blank returns no results rather than the whole board.',
                example: 'Eudora'
            }),
            limit: z.coerce.number().int().min(1).max(50).optional().openapi({ example: 10 })
        })
    },
    responses: {
        200: {
            description: 'Matching listings, newest page first',
            content: { 'application/json': { schema: propertySearchResponseSchema } }
        },
        400: errorContent('Query failed validation'),
        401: errorContent('No session'),
        502: errorContent('Repliers is unreachable, or answered with a shape that no longer matches')
    }
})

registry.registerPath({
    method: 'get',
    path: '/api/properties/mls/{mlsNumber}',
    summary: 'One listing, mapped to property fields',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session. The autofill source: MLS values mapped onto the property form, nothing saved. Cached for 24 hours by MLS number.',
    tags: ['properties'],
    request: {
        params: z.object({
            mlsNumber: z.string().openapi({ example: 'ACT8714298' })
        })
    },
    responses: {
        200: {
            description: 'The listing as a property draft',
            content: { 'application/json': { schema: propertyDraftResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No listing with that MLS number'),
        502: errorContent('Repliers is unreachable, or answered with a shape that no longer matches')
    }
})

registry.registerPath({
    method: 'get',
    path: '/api/transactions/{id}/property',
    summary: "A transaction's saved property",
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. A transaction someone else owns answers 404, the same as one that does not exist.',
    tags: ['properties'],
    request: {
        params: z.object({
            id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' })
        })
    },
    responses: {
        200: {
            description: 'The saved property',
            content: { 'application/json': { schema: propertyResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction, or it has no property yet')
    }
})

registry.registerPath({
    method: 'put',
    path: '/api/transactions/{id}/property',
    summary: "Save a transaction's property",
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. Creates the property and links it on the first call, replaces it in place afterwards. The whole form is sent every time — an absent optional field clears it.',
    tags: ['properties'],
    request: {
        params: z.object({
            id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' })
        }),
        body: {
            required: true,
            content: { 'application/json': { schema: savePropertyRequestSchema } }
        }
    },
    responses: {
        200: {
            description: 'The saved property',
            content: { 'application/json': { schema: propertyResponseSchema } }
        },
        400: errorContent('Body failed validation'),
        401: errorContent('No session'),
        404: errorContent('No such transaction')
    }
})
