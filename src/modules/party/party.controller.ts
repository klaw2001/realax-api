import type { Request, Response } from 'express'

import {
    createTransactionParty,
    getTransactionParty,
    listTransactionParties,
    softDeleteTransactionParty,
    updateTransactionParty
} from '@/modules/party/party.service'
import type { ErrorResponse } from '@/schemas/common'
import {
    createPartyRequestSchema,
    deletePartyResponseSchema,
    partyListResponseSchema,
    partyResponseSchema,
    updatePartyRequestSchema
} from '@/schemas/party'

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

const transactionNotFound: ErrorResponse = {
    error: 'transaction_not_found',
    message: 'No such transaction'
}

/**
 * The answer for a party that is not on this transaction, was removed, or
 * belongs to someone else's transaction. One message for all three: which it
 * was is not something a caller who does not own the transaction gets to learn.
 */
const partyNotFound: ErrorResponse = {
    error: 'party_not_found',
    message: 'No such party on this transaction'
}

/**
 * A validation failure as field names only.
 *
 * The rejected values are a client's name, address and date of birth. They do
 * not go in an error body, and they are not logged.
 */
const invalidRequest = (paths: string[]): ErrorResponse => ({
    error: 'invalid_request',
    message: `Check these fields: ${[...new Set(paths)].join(', ') || 'the request body'}`
})

/** `GET /api/transactions/:id/parties`. */
export const getParties = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const parties = await listTransactionParties(req.params.id ?? '', req.agent.id)

    if (parties === null) {
        res.status(404).json(transactionNotFound)

        return
    }

    res.status(200).json(partyListResponseSchema.parse({ parties }))
}

/** `POST /api/transactions/:id/parties`. */
export const postParty = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const parsed = createPartyRequestSchema.safeParse(req.body)

    if (!parsed.success) {
        res.status(400).json(invalidRequest(parsed.error.issues.map(issue => issue.path.join('.'))))

        return
    }

    const party = await createTransactionParty(req.params.id ?? '', req.agent.id, parsed.data)

    if (party === null) {
        res.status(404).json(transactionNotFound)

        return
    }

    res.status(201).json(partyResponseSchema.parse({ party }))
}

/** `GET /api/transactions/:id/parties/:partyId`. */
export const getParty = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const party = await getTransactionParty(
        req.params.id ?? '',
        req.agent.id,
        req.params.partyId ?? ''
    )

    if (party === null) {
        res.status(404).json(partyNotFound)

        return
    }

    res.status(200).json(partyResponseSchema.parse({ party }))
}

/** `PATCH /api/transactions/:id/parties/:partyId`. */
export const patchParty = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const parsed = updatePartyRequestSchema.safeParse(req.body)

    if (!parsed.success) {
        res.status(400).json(invalidRequest(parsed.error.issues.map(issue => issue.path.join('.'))))

        return
    }

    const party = await updateTransactionParty(
        req.params.id ?? '',
        req.agent.id,
        req.params.partyId ?? '',
        parsed.data
    )

    if (party === null) {
        res.status(404).json(partyNotFound)

        return
    }

    res.status(200).json(partyResponseSchema.parse({ party }))
}

/** `DELETE /api/transactions/:id/parties/:partyId`. Soft — see the service. */
export const deleteParty = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const deleted = await softDeleteTransactionParty(
        req.params.id ?? '',
        req.agent.id,
        req.params.partyId ?? ''
    )

    if (!deleted) {
        res.status(404).json(partyNotFound)

        return
    }

    res.status(200).json(deletePartyResponseSchema.parse({ deleted: true }))
}
