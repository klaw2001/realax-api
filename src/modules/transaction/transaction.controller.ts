import type { Request, Response } from 'express'

import {
    createTransaction,
    findTransaction,
    listTransactions
} from '@/modules/transaction/transaction.service'
import type { ErrorResponse } from '@/schemas/common'
import {
    createTransactionRequestSchema,
    transactionListQuerySchema,
    transactionListResponseSchema,
    transactionResponseSchema
} from '@/schemas/transaction'

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

/**
 * `GET /api/transactions`. Scoped to the session's agent.
 *
 * Every filter is optional and the defaults are the whole list, newest first,
 * so a caller that sends no query at all gets what it always did — one page of
 * it, which is the only behaviour change for an older client.
 *
 * A bad parameter is a 400 rather than a silently ignored filter. A list that
 * quietly returned everything because `status=Draft` was not a valid enum value
 * is the kind of wrong answer nobody notices until it matters.
 */
export const getTransactions = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const query = transactionListQuerySchema.safeParse(req.query)

    if (!query.success) {
        res.status(400).json({
            error: 'invalid_request',
            message: `Not a valid filter: ${query.error.issues.map(issue => issue.path.join('.')).join(', ')}`
        } satisfies ErrorResponse)

        return
    }

    const result = await listTransactions(req.agent.id, query.data)

    res.status(200).json(transactionListResponseSchema.parse(result))
}

/**
 * `GET /api/transactions/:id`.
 *
 * The transaction itself, without its relations. The property, the parties and
 * the entries each have their own endpoint under this one and are fetched
 * separately — the pages that show them are separate pages, and an overview
 * that had to load all of it to render a status line would be the slowest
 * screen in the product.
 */
export const getTransaction = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const transaction = await findTransaction(req.params.id ?? '', req.agent.id)

    if (!transaction) {
        res.status(404).json({
            error: 'transaction_not_found',
            message: 'No such transaction'
        } satisfies ErrorResponse)

        return
    }

    res.status(200).json(transactionResponseSchema.parse({ transaction }))
}

/** `POST /api/transactions`. */
export const postTransaction = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const parsed = createTransactionRequestSchema.safeParse(req.body)

    if (!parsed.success) {
        // A well-formed request naming LISTING or LEASE is not a malformed
        // request — it is a flow that is not built yet, and the message says
        // so rather than reading as a validation failure.
        const type: unknown = (req.body as { type?: unknown })?.type

        const body: ErrorResponse =
            type === 'LISTING' || type === 'LEASE'
                ? {
                      error: 'transaction_type_unavailable',
                      message: `${String(type).toLowerCase()} transactions are not available yet`
                  }
                : {
                      error: 'invalid_request',
                      message: 'A transaction type of PURCHASE is required'
                  }

        res.status(400).json(body)

        return
    }

    const transaction = await createTransaction(req.agent.id, parsed.data.type)

    res.status(201).json(transactionResponseSchema.parse({ transaction }))
}
