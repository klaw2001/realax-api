import type { Request, Response } from 'express'

import {
    createListingTransaction,
    listTransactions
} from '@/modules/transaction/transaction.service'
import type { ErrorResponse } from '@/schemas/common'
import {
    createTransactionRequestSchema,
    transactionListResponseSchema,
    transactionResponseSchema
} from '@/schemas/transaction'

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

/** `GET /api/transactions`. Scoped to the session's agent. */
export const getTransactions = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const transactions = await listTransactions(req.agent.id)

    res.status(200).json(transactionListResponseSchema.parse({ transactions }))
}

/** `POST /api/transactions`. */
export const postTransaction = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const parsed = createTransactionRequestSchema.safeParse(req.body)

    if (!parsed.success) {
        // A well-formed request naming PURCHASE or LEASE is not a malformed
        // request — it is a flow that is not built yet, and the message says
        // so rather than reading as a validation failure.
        const type: unknown = (req.body as { type?: unknown })?.type

        const body: ErrorResponse =
            type === 'PURCHASE' || type === 'LEASE'
                ? {
                      error: 'transaction_type_unavailable',
                      message: `${String(type).toLowerCase()} transactions are not available yet`
                  }
                : {
                      error: 'invalid_request',
                      message: 'A transaction type of LISTING is required'
                  }

        res.status(400).json(body)

        return
    }

    const transaction = await createListingTransaction(req.agent.id)

    res.status(201).json(transactionResponseSchema.parse({ transaction }))
}
