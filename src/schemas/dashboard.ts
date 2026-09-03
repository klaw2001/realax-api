import { registry, z } from '@/openapi/registry'
import { errorContent } from '@/schemas/common'
import { transactionListItemSchema, transactionStatusSchema } from '@/schemas/transaction'

/**
 * The agent's home page (UX plan item 08).
 *
 * One request, because the alternative is six. The page opens with a count per
 * status, a list of what needs the agent today and the deals they touched last,
 * and fanning that out from the browser would make the first screen of the
 * product the slowest one.
 *
 * **Actionable first, counts second.** An Ontario realtor opening this app
 * wants to know what needs them today, not how many transactions they have
 * ever had. That ordering is the reason `attention` is a first-class part of
 * this payload rather than something derived from the counts.
 */

/**
 * Why a transaction is on the attention list.
 *
 * The `kind` is what the frontend routes and words from — the wording belongs
 * next to the screen it appears on, and the deep link belongs next to the
 * router. What the API owes is the fact and the number behind it.
 *
 * Three kinds, and only three, because these are the three this system can
 * currently know. There is no `awaiting_signature` here: the signing module is
 * not built, `SigningEnvelope` has never been written to, and a block that
 * always renders empty is worse than one that is not there.
 */
export const attentionKindSchema = registry.register(
    'AttentionKind',
    z.enum(['compliance_blocked', 'identity_missing', 'stale_draft']).openapi({
        description:
            '`compliance_blocked` — the last compliance check on a form failed, and `count` is how many fields it named. `identity_missing` — `count` parties on the transaction have no identity record, which is FINTRAC exposure. `stale_draft` — a draft nobody has touched, and `count` is how many days.',
        example: 'compliance_blocked'
    })
)

export type AttentionKind = z.infer<typeof attentionKindSchema>

export const attentionItemSchema = registry.register(
    'AttentionItem',
    z.object({
        kind: attentionKindSchema,
        transactionId: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),

        /** So a row reads as an address rather than an id. Null on a bare draft. */
        address: z.union([z.string(), z.null()]).openapi({ example: '18 Maple Grove Ave' }),

        count: z.number().int().openapi({
            description: 'What the kind says it counts. Never zero — a row with nothing behind it is not a row.',
            example: 3
        })
    })
)

export type AttentionItem = z.infer<typeof attentionItemSchema>

export const dashboardResponseSchema = registry.register(
    'DashboardResponse',
    z.object({
        /**
         * Every status, including the ones at zero.
         *
         * A tile that disappears when its count is zero makes the row of tiles
         * change shape as the day goes on, and "no drafts" is worth seeing.
         */
        statusCounts: z.record(transactionStatusSchema, z.number().int()).openapi({
            example: {
                DRAFT: 3,
                COMPLIANCE_PENDING: 1,
                READY_TO_SIGN: 0,
                OUT_FOR_SIGNATURE: 2,
                COMPLETED: 11,
                CANCELLED: 0
            }
        }),

        /** Completed since the first of this month, which is the number agents quote. */
        completedThisMonth: z.number().int().openapi({ example: 2 }),

        /** What needs the agent today, most-blocking first. Capped — this is a list to act on, not a report. */
        attention: z.array(attentionItemSchema),

        /** The transactions touched most recently, in the same shape the list page renders. */
        recent: z.array(transactionListItemSchema)
    })
)

export type DashboardResponse = z.infer<typeof dashboardResponseSchema>

registry.registerPath({
    method: 'get',
    path: '/api/me/dashboard',
    summary: "Everything the agent's home page shows",
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session. Scoped to the caller. One request rather than six: the home page is the first screen of the product and fanning its blocks out from the browser would make it the slowest. Counts cover every status including the ones at zero, so the row of tiles does not change shape as the day goes on. The attention list is capped and ordered most-blocking first — it is a list to act on, not a report.',
    tags: ['dashboard'],
    responses: {
        200: {
            description: 'Counts, what needs attention, and the most recently touched transactions',
            content: { 'application/json': { schema: dashboardResponseSchema } }
        },
        401: errorContent('No session')
    }
})
