import type { Request, Response } from 'express'

import {
    TransactionNotFoundError,
    getTransactionEntries,
    saveTransactionEntries
} from '@/modules/entries/entries.service'
import type { ErrorResponse } from '@/schemas/common'
import {
    saveTransactionEntriesRequestSchema,
    transactionEntriesResponseSchema
} from '@/schemas/entries'

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

const transactionNotFound: ErrorResponse = {
    error: 'transaction_not_found',
    message: 'No such transaction'
}

/** `GET /api/transactions/:id/entries`. */
export const getEntries = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    try {
        const entries = await getTransactionEntries(req.params.id ?? '', req.agent.id)

        res.status(200).json(transactionEntriesResponseSchema.parse({ entries }))
    } catch (error) {
        if (error instanceof TransactionNotFoundError) {
            res.status(404).json(transactionNotFound)

            return
        }

        throw error
    }
}

/** `PUT /api/transactions/:id/entries`. */
export const putEntries = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const parsed = saveTransactionEntriesRequestSchema.safeParse(req.body)

    if (!parsed.success) {
        // The field names, not the values. A rejected purchase price must not
        // come back in a message that ends up in a log.
        const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))]

        res.status(400).json({
            error: 'invalid_request',
            message: `Check these fields: ${fields.join(', ') || 'the request body'}`
        } satisfies ErrorResponse)

        return
    }

    try {
        const entries = await saveTransactionEntries(req.params.id ?? '', req.agent.id, parsed.data)

        res.status(200).json(transactionEntriesResponseSchema.parse({ entries }))
    } catch (error) {
        if (error instanceof TransactionNotFoundError) {
            res.status(404).json(transactionNotFound)

            return
        }

        throw error
    }
}
