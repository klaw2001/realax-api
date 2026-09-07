import { registry, z } from '@/openapi/registry'
import { errorContent } from '@/schemas/common'

/**
 * The three transaction types the product covers.
 *
 * All three are named here because the picker shows all three — but only
 * `PURCHASE` is wired live. See `createTransactionRequestSchema` for where that
 * restriction is enforced.
 *
 * Purchase rather than Listing because that is where the forms are: every OREA
 * form the library holds — 100, 320, 371 and 801 — belongs to a purchase, and
 * Listing has none of its own. Reading an existing `LISTING` row stays legal;
 * the enum is the shape of the column, not of what can be created.
 */
export const transactionTypeSchema = registry.register(
    'TransactionType',
    z.enum(['LISTING', 'PURCHASE', 'LEASE']).openapi({ example: 'PURCHASE' })
)

export type TransactionType = z.infer<typeof transactionTypeSchema>

/**
 * Lifecycle. A transaction starts at `DRAFT` and only reaches `READY_TO_SIGN`
 * once the compliance gate passes — nothing in this phase advances it.
 */
export const TRANSACTION_STATUSES = [
    'DRAFT',
    'COMPLIANCE_PENDING',
    'READY_TO_SIGN',
    'OUT_FOR_SIGNATURE',
    'COMPLETED',
    'CANCELLED'
] as const

export const transactionStatusSchema = registry.register(
    'TransactionStatus',
    z.enum(TRANSACTION_STATUSES).openapi({ example: 'DRAFT' })
)

export type TransactionStatus = z.infer<typeof transactionStatusSchema>

export const transactionSchema = registry.register(
    'Transaction',
    z.object({
        id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),
        type: transactionTypeSchema,
        status: transactionStatusSchema,
        agentId: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),
        propertyId: z.union([z.string(), z.null()]).openapi({
            description: 'Set in build plan 1.4, when a property is attached. Null on a fresh draft.'
        }),
        createdAt: z.iso.datetime().openapi({ example: '2026-09-01T09:00:00.000Z' }),
        updatedAt: z.iso.datetime().openapi({ example: '2026-09-01T09:00:00.000Z' })
    })
)

export type Transaction = z.infer<typeof transactionSchema>

export const transactionResponseSchema = registry.register(
    'TransactionResponse',
    z.object({
        transaction: transactionSchema
    })
)

export type TransactionResponse = z.infer<typeof transactionResponseSchema>

/**
 * The property, as much of it as a list row shows.
 *
 * Not the whole `Property`: a table of twenty rows does not need legal
 * descriptions and frontage, and sending them would make the list the heaviest
 * request in the product for the sake of two lines of text per row.
 */
export const transactionPropertySummarySchema = registry.register(
    'TransactionPropertySummary',
    z.object({
        id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),
        address: z.string().openapi({ example: '18 Maple Grove Ave' }),
        city: z.string().openapi({ example: 'Toronto' }),
        mlsNumber: z.union([z.string(), z.null()]).openapi({
            description: 'Null for a property entered by hand rather than found on the board.',
            example: 'C8123456'
        })
    })
)

export type TransactionPropertySummary = z.infer<typeof transactionPropertySummarySchema>

/**
 * A transaction as a row in the list.
 *
 * A superset of `Transaction`, not a replacement for it: the detail endpoint
 * still answers the plain shape. The two extra fields exist because the list is
 * a table an agent reads at a glance, and both of them would otherwise cost a
 * request per row — the address is what identifies a deal to a human, and the
 * party count is how they see at a glance that a listing has no seller on it
 * yet.
 */
export const transactionListItemSchema = registry.register(
    'TransactionListItem',
    transactionSchema.extend({
        property: z.union([transactionPropertySummarySchema, z.null()]).openapi({
            description: 'Null on a draft that has not had a property attached yet.'
        }),
        partyCount: z.number().int().openapi({
            description: 'Parties still on the transaction. Removed ones are not counted.',
            example: 2
        })
    })
)

export type TransactionListItem = z.infer<typeof transactionListItemSchema>

/**
 * What the list can be narrowed and ordered by.
 *
 * **Server-side, deliberately.** Filters belong next to the data: an agent with
 * three years of deals should not be sent all of them so the browser can hide
 * most, and the same query parameters are what makes a filtered list a link —
 * the home page's stat tiles are links into this endpoint, not dead numbers.
 *
 * Every field is optional and the defaults are the unfiltered list, so an older
 * client calling `GET /api/transactions` with no query at all still works.
 */
export const transactionListQuerySchema = registry.register(
    'TransactionListQuery',
    z.object({
        search: z
            .string()
            .trim()
            .max(200)
            .optional()
            .openapi({
                description:
                    'Free text over the property address, city and MLS number. Case-insensitive, matches anywhere in the value.',
                example: 'maple'
            }),

        type: transactionTypeSchema.optional(),

        /*
         * Repeated rather than comma-separated: `?status=DRAFT&status=COMPLETED`
         * is what a browser's URLSearchParams produces from a multi-select, and
         * a comma-separated list would need escaping rules for a value that
         * will never contain a comma. Express hands over a string for one and
         * an array for several, so both are accepted and normalised here.
         */
        status: z
            .union([transactionStatusSchema, z.array(transactionStatusSchema)])
            .optional()
            .transform(value => (value === undefined ? undefined : [value].flat()))
            .openapi({
                type: 'array',

                // The values are spelled out rather than left as a bare string
                // array. A repeated query parameter has no schema of its own to
                // point at here, and without the enum the generated frontend
                // type is `string[]` — which compiles for a misspelled status
                // and answers 400 at the keyboard. Generated types exist to
                // move that failure to build time.
                items: { type: 'string', enum: [...TRANSACTION_STATUSES] },
                description: 'Repeatable. Any of the given statuses matches.'
            }),

        /*
         * Calendar dates rather than instants. An agent filtering "created in
         * August" is not thinking in timezones, and `createdTo` covers the
         * whole of the day named — a range ending today that excluded today
         * would be wrong in the way nobody reports and everybody notices.
         */
        createdFrom: z.iso.date().optional().openapi({ example: '2026-08-01' }),
        createdTo: z.iso.date().optional().openapi({ example: '2026-08-31' }),

        sort: z.enum(['createdAt', 'updatedAt', 'status']).default('createdAt').openapi({
            description: 'Newest first by default.'
        }),
        direction: z.enum(['asc', 'desc']).default('desc'),

        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25)
    })
)

export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>

export const transactionListResponseSchema = registry.register(
    'TransactionListResponse',
    z.object({
        transactions: z.array(transactionListItemSchema),

        /**
         * How many match the filters, not how many are on this page.
         *
         * The pager needs it, and so does the empty state: nothing matching a
         * filter and nothing existing at all are different things to say.
         */
        total: z.number().int().openapi({ example: 42 }),
        page: z.number().int().openapi({ example: 1 }),
        pageSize: z.number().int().openapi({ example: 25 })
    })
)

export type TransactionListResponse = z.infer<typeof transactionListResponseSchema>

/**
 * Create a transaction.
 *
 * `type` is a literal, not the `TransactionType` enum: Listing and Lease are a
 * deliberate scoping decision for this phase, and the contract is the honest
 * place to say so. Generating the frontend types from this makes sending
 * `LISTING` a compile error there rather than a runtime 400 — and when those
 * flows are built, widening this literal is what turns them on.
 *
 * It stays a single literal rather than becoming a union for that reason. A
 * union of one is the same runtime check but a weaker type: the frontend's
 * `CreatableTransactionType` narrows to exactly what the API will take, and
 * that narrowing is the whole point of generating the client from this file.
 */
export const createTransactionRequestSchema = registry.register(
    'CreateTransactionRequest',
    z.object({
        type: z.literal('PURCHASE').openapi({
            description:
                'Only PURCHASE is wired — it is the flow every OREA form in the library belongs to. Listing and Lease are shown in the picker and marked as coming next; the API refuses them.',
            example: 'PURCHASE'
        })
    })
)

export type CreateTransactionRequest = z.infer<typeof createTransactionRequestSchema>

registry.registerPath({
    method: 'get',
    path: '/api/transactions',
    summary: "The signed-in agent's transactions",
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session. Scoped to the caller — there is no agent filter, because there is no way to read another agent\'s transactions. Newest first unless ordered otherwise. Every query parameter is optional; with none of them this is the whole list, one page at a time. Filtering happens here rather than in the browser so that a filtered list is a link that survives a reload, and so that an agent with years of deals is not sent all of them.',
    tags: ['transactions'],
    request: { query: transactionListQuerySchema },
    responses: {
        200: {
            description: 'One page of the transactions owned by the caller, with the total that matched',
            content: { 'application/json': { schema: transactionListResponseSchema } }
        },
        400: errorContent('A query parameter is not valid'),
        401: errorContent('No session')
    }
})

registry.registerPath({
    method: 'get',
    path: '/api/transactions/{id}',
    summary: 'One transaction',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. A transaction someone else owns answers 404, the same as one that does not exist. The transaction alone — its property, parties and entries each have their own endpoint under this one.',
    tags: ['transactions'],
    request: {
        params: z.object({
            id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' })
        })
    },
    responses: {
        200: {
            description: 'The transaction',
            content: { 'application/json': { schema: transactionResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction')
    }
})

registry.registerPath({
    method: 'post',
    path: '/api/transactions',
    summary: 'Start a transaction',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session. Creates a DRAFT owned by the caller. Only PURCHASE is accepted in this phase — LISTING and LEASE are refused with 400.',
    tags: ['transactions'],
    request: {
        body: {
            required: true,
            content: { 'application/json': { schema: createTransactionRequestSchema } }
        }
    },
    responses: {
        201: {
            description: 'The new draft transaction',
            content: { 'application/json': { schema: transactionResponseSchema } }
        },
        400: errorContent('Body failed validation, or a transaction type that is not wired yet'),
        401: errorContent('No session')
    }
})
