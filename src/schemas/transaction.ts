import { registry, z } from '@/openapi/registry'
import { errorContent } from '@/schemas/common'

/**
 * The three transaction types the product covers.
 *
 * All three are named here because the picker shows all three — but only
 * `LISTING` is wired live (build plan 1.2). See `createTransactionRequestSchema`
 * for where that restriction is enforced.
 */
export const transactionTypeSchema = registry.register(
    'TransactionType',
    z.enum(['LISTING', 'PURCHASE', 'LEASE']).openapi({ example: 'LISTING' })
)

export type TransactionType = z.infer<typeof transactionTypeSchema>

/**
 * Lifecycle. A transaction starts at `DRAFT` and only reaches `READY_TO_SIGN`
 * once the compliance gate passes — nothing in this phase advances it.
 */
export const transactionStatusSchema = registry.register(
    'TransactionStatus',
    z
        .enum([
            'DRAFT',
            'COMPLIANCE_PENDING',
            'READY_TO_SIGN',
            'OUT_FOR_SIGNATURE',
            'COMPLETED',
            'CANCELLED'
        ])
        .openapi({ example: 'DRAFT' })
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

export const transactionListResponseSchema = registry.register(
    'TransactionListResponse',
    z.object({
        transactions: z.array(transactionSchema)
    })
)

export type TransactionListResponse = z.infer<typeof transactionListResponseSchema>

/**
 * Create a transaction.
 *
 * `type` is a literal, not the `TransactionType` enum: Purchase and Lease are a
 * deliberate scoping decision for this phase, and the contract is the honest
 * place to say so. Generating the frontend types from this makes sending
 * `PURCHASE` a compile error there rather than a runtime 400 — and when those
 * flows are built, widening this literal is what turns them on.
 */
export const createTransactionRequestSchema = registry.register(
    'CreateTransactionRequest',
    z.object({
        type: z.literal('LISTING').openapi({
            description:
                'Only LISTING is wired. Purchase and Lease are shown in the picker and marked as coming next; the API refuses them.',
            example: 'LISTING'
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
        'Requires a session. Scoped to the caller — there is no agent filter, because there is no way to read another agent\'s transactions. Newest first.',
    tags: ['transactions'],
    responses: {
        200: {
            description: 'The transactions owned by the caller',
            content: { 'application/json': { schema: transactionListResponseSchema } }
        },
        401: errorContent('No session')
    }
})

registry.registerPath({
    method: 'get',
    path: '/api/transactions/{id}',
    summary: 'One transaction',
    security: [{ sessionCookie: [] }],
    description:
        "Requires a session, and the transaction must belong to the caller. A transaction someone else owns answers 404, the same as one that does not exist. The transaction alone — its property, parties and entries each have their own endpoint under this one.",
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
        'Requires a session. Creates a DRAFT owned by the caller. Only LISTING is accepted in this phase — PURCHASE and LEASE are refused with 400.',
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
