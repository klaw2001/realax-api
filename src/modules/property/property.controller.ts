import type { Request, Response } from 'express'

import { RepliersError } from '@/integrations/repliers/client'
import logger from '@/lib/logger'
import {
    TransactionNotFoundError,
    getPropertyDraft,
    getTransactionProperty,
    saveTransactionProperty,
    searchProperties
} from '@/modules/property/property.service'
import type { ErrorResponse } from '@/schemas/common'
import {
    propertyDraftResponseSchema,
    propertyResponseSchema,
    propertySearchResponseSchema,
    savePropertyRequestSchema
} from '@/schemas/property'
import { z } from '@/openapi/registry'

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

const transactionNotFound: ErrorResponse = {
    error: 'transaction_not_found',
    message: 'No such transaction'
}

/**
 * An upstream failure, as an answer the agent can act on.
 *
 * 502 rather than 500: the request was fine and ours was too — Repliers is the
 * one that is down or has moved. The distinction matters when the search box
 * fails during a demo and someone has to say why.
 */
const repliersFailed = (error: RepliersError): ErrorResponse => ({
    error: error.kind === 'schema' ? 'mls_response_unexpected' : 'mls_unavailable',
    message:
        error.kind === 'schema'
            ? 'The MLS response did not match the expected shape. This is being reported.'
            : 'MLS search is unavailable right now. Try again in a moment.'
})

/** Turn a `RepliersError` into a 502, and let anything else reach Express. */
const sendRepliersError = (error: unknown, res: Response) => {
    if (!(error instanceof RepliersError)) {
        throw error
    }

    // The message is logged, the client gets the generic one — an upstream
    // message can carry the query, which is a client's property search.
    logger.error('repliers call failed', { kind: error.kind, status: error.status })

    res.status(502).json(repliersFailed(error))
}

const searchQuerySchema = z.object({
    q: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional()
})

/** `GET /api/properties/search`. */
export const getPropertySearch = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const parsed = searchQuerySchema.safeParse(req.query)

    if (!parsed.success) {
        res.status(400).json({
            error: 'invalid_request',
            message: 'q must be a string of at most 200 characters, and limit a number from 1 to 50'
        } satisfies ErrorResponse)

        return
    }

    try {
        // An empty box is answered here rather than upstream — a blank query
        // would otherwise return the whole board a page at a time, and be
        // billed for it. The client debounces; this is the backstop.
        const response = await searchProperties(parsed.data.q ?? '', parsed.data.limit)

        res.status(200).json(propertySearchResponseSchema.parse(response))
    } catch (error) {
        sendRepliersError(error, res)
    }
}

/** `GET /api/properties/mls/:mlsNumber`. The autofill source. */
export const getPropertyByMls = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    try {
        const property = await getPropertyDraft(req.params.mlsNumber ?? '')

        if (property === null) {
            res.status(404).json({
                error: 'listing_not_found',
                message: 'No listing with that MLS number'
            } satisfies ErrorResponse)

            return
        }

        res.status(200).json(propertyDraftResponseSchema.parse({ property }))
    } catch (error) {
        sendRepliersError(error, res)
    }
}

/** `GET /api/transactions/:id/property`. */
export const getProperty = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const property = await getTransactionProperty(req.params.id ?? '', req.agent.id)

    if (property === null) {
        // Also the answer for a transaction the caller does not own. A 403 here
        // would confirm that someone else's transaction id is real.
        res.status(404).json({
            error: 'property_not_found',
            message: 'This transaction has no property yet'
        } satisfies ErrorResponse)

        return
    }

    res.status(200).json(propertyResponseSchema.parse({ property }))
}

/** `PUT /api/transactions/:id/property`. */
export const putProperty = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const parsed = savePropertyRequestSchema.safeParse(req.body)

    if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))]

        res.status(400).json({
            error: 'invalid_request',
            message: `Check these fields: ${fields.join(', ') || 'the request body'}`
        } satisfies ErrorResponse)

        return
    }

    try {
        const property = await saveTransactionProperty(req.params.id ?? '', req.agent.id, parsed.data)

        res.status(200).json(propertyResponseSchema.parse({ property }))
    } catch (error) {
        if (error instanceof TransactionNotFoundError) {
            res.status(404).json(transactionNotFound)

            return
        }

        throw error
    }
}
