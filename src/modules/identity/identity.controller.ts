import type { Request, Response } from 'express'
import type { UploadedFile } from 'express-fileupload'

import { OcrError } from '@/integrations/ocr/provider'
import logger from '@/lib/logger'
import {
    PartyNotFoundError,
    ScanAlreadyConfirmedError,
    ScanNotFoundError,
    UnsupportedDocumentError,
    confirmIdentityScan,
    listPartyIdentityRecords,
    scanIdentityDocument,
    scanIdentityDocumentForNewParty
} from '@/modules/identity/identity.service'
import { TransactionNotFoundError } from '@/modules/transaction/transaction.service'
import type { ErrorResponse } from '@/schemas/common'
import {
    confirmIdentityScanRequestSchema,
    confirmIdentityScanResponseSchema,
    identityDocumentTypeSchema,
    identityRecordListResponseSchema,
    scanIdentityResponseSchema
} from '@/schemas/identity'

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

/**
 * The one place a failed reading becomes an answer.
 *
 * Two kinds reach here, and they need opposite things said about them.
 * `unavailable` is an outage: the reader will be back, and "try again in a
 * moment" is true. `misconfigured` is the reader refusing us — a missing
 * subscription, a wrong key — and telling an agent to try again sends them
 * round a loop that cannot end. Both are 502 because both are this service's
 * problem rather than the request's, but the code differs so the frontend can
 * stop offering a retry button for the one where retrying is pointless.
 *
 * `unreadable` never reaches here: the service stores the image and answers
 * with an empty form to type into, which is not an error.
 */
const sendOcrError = (error: OcrError, transactionId: string, res: Response): void => {
    logger.warn('identity scan failed', { transactionId, kind: error.kind })

    if (error.kind === 'misconfigured') {
        res.status(502).json({
            error: 'ocr_misconfigured',
            message:
                'The document reader is not set up correctly, so it cannot read this. Retrying will not help — enter the details by hand and report this.'
        } satisfies ErrorResponse)

        return
    }

    res.status(502).json({
        error: 'ocr_unavailable',
        message: 'The document reader is unavailable right now. Try again in a moment.'
    } satisfies ErrorResponse)
}

/**
 * Two ways to not find something, one answer to each.
 *
 * A transaction that is not yours and one that does not exist are the same
 * reply, deliberately; so are a party that was removed and one that never
 * existed.
 */
const sendNotFound = (error: unknown, res: Response): boolean => {
    if (error instanceof TransactionNotFoundError) {
        res.status(404).json({
            error: 'transaction_not_found',
            message: 'No such transaction'
        } satisfies ErrorResponse)

        return true
    }

    if (error instanceof PartyNotFoundError) {
        res.status(404).json({
            error: 'party_not_found',
            message: 'No such party on this transaction'
        } satisfies ErrorResponse)

        return true
    }

    if (error instanceof ScanNotFoundError) {
        res.status(404).json({
            error: 'scan_not_found',
            message: 'No such scan for this party'
        } satisfies ErrorResponse)

        return true
    }

    return false
}

const params = (req: Request) => ({
    transactionId: req.params.id ?? '',
    partyId: req.params.partyId ?? ''
})

/** The one uploaded file, whether it arrived alone or in an array. */
const uploadedFile = (req: Request): UploadedFile | null => {
    const file = req.files?.document

    if (!file) {
        return null
    }

    return Array.isArray(file) ? (file[0] ?? null) : file
}

/**
 * The upload both scan endpoints read, validated once.
 *
 * Returns null once it has answered for itself, so a caller stops on null
 * rather than repeating which of the two things was wrong with the request.
 */
const uploadFromRequest = (req: Request, res: Response) => {
    const file = uploadedFile(req)

    if (!file) {
        res.status(400).json({
            error: 'invalid_request',
            message: 'Attach the document as `document`'
        } satisfies ErrorResponse)

        return null
    }

    const documentType = identityDocumentTypeSchema.safeParse(
        (req.body as { documentType?: unknown })?.documentType
    )

    if (!documentType.success) {
        res.status(400).json({
            error: 'invalid_request',
            message: 'documentType must be drivers_licence or passport'
        } satisfies ErrorResponse)

        return null
    }

    return {
        bytes: file.data,
        mimeType: file.mimetype,
        documentType: documentType.data
    }
}

/**
 * `POST /api/transactions/:id/identity/scans`.
 *
 * Reading a document before there is anybody to attach it to — the agent is
 * adding a party and the licence is what the form will be filled from. The scan
 * comes back unattached and becomes that person's when it is confirmed.
 */
export const postUnassignedIdentityScan = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const { transactionId } = params(req)
    const upload = uploadFromRequest(req, res)

    if (!upload) {
        return
    }

    try {
        const result = await scanIdentityDocumentForNewParty(transactionId, req.agent.id, upload)

        res.status(201).json(scanIdentityResponseSchema.parse(result))
    } catch (error) {
        if (sendNotFound(error, res)) {
            return
        }

        if (error instanceof UnsupportedDocumentError) {
            res.status(400).json({
                error: 'unsupported_document',
                message: error.message
            } satisfies ErrorResponse)

            return
        }

        if (error instanceof OcrError) {
            sendOcrError(error, transactionId, res)

            return
        }

        throw error
    }
}

/**
 * `POST /api/transactions/:id/parties/:partyId/identity`.
 *
 * Multipart, because the thing being sent is a photograph of a card.
 */
export const postIdentityScan = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const { transactionId, partyId } = params(req)
    const upload = uploadFromRequest(req, res)

    if (!upload) {
        return
    }

    try {
        const result = await scanIdentityDocument(transactionId, req.agent.id, partyId, upload)

        res.status(201).json(scanIdentityResponseSchema.parse(result))
    } catch (error) {
        if (sendNotFound(error, res)) {
            return
        }

        if (error instanceof UnsupportedDocumentError) {
            res.status(400).json({
                error: 'unsupported_document',
                message: error.message
            } satisfies ErrorResponse)

            return
        }

        if (error instanceof OcrError) {
            // Never `unreadable`. An image with no document in it is handled in
            // the service, which stores it and answers with a scan the agent
            // can type into — it is the reader being unreachable or refusing
            // that has nothing to offer.
            //
            // The image is stored either way, deliberately, so neither an
            // outage nor a misconfiguration loses the agent's upload.
            sendOcrError(error, transactionId, res)

            return
        }

        throw error
    }
}

/**
 * `POST /api/transactions/:id/parties/:partyId/identity/scans/:scanId/confirm`.
 *
 * The agent has read what came back, corrected it against the card, and is
 * saying so. This is the call that creates the record; the upload before it
 * created nothing but a reading.
 */
export const postIdentityScanConfirmation = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const { transactionId, partyId } = params(req)
    const confirmed = confirmIdentityScanRequestSchema.safeParse(req.body)

    if (!confirmed.success) {
        res.status(400).json({
            error: 'invalid_request',
            message: 'Confirm a document type, and an expiry date or null'
        } satisfies ErrorResponse)

        return
    }

    try {
        const record = await confirmIdentityScan(
            transactionId,
            req.agent.id,
            partyId,
            req.params.scanId ?? '',
            confirmed.data
        )

        res.status(201).json(confirmIdentityScanResponseSchema.parse({ record }))
    } catch (error) {
        if (sendNotFound(error, res)) {
            return
        }

        if (error instanceof ScanAlreadyConfirmedError) {
            res.status(409).json({
                error: 'scan_already_confirmed',
                message: 'That scan has already been confirmed'
            } satisfies ErrorResponse)

            return
        }

        throw error
    }
}

/** `GET /api/transactions/:id/parties/:partyId/identity`. */
export const getIdentityRecords = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const { transactionId, partyId } = params(req)

    try {
        const records = await listPartyIdentityRecords(transactionId, req.agent.id, partyId)

        res.status(200).json(identityRecordListResponseSchema.parse({ records }))
    } catch (error) {
        if (sendNotFound(error, res)) {
            return
        }

        throw error
    }
}
