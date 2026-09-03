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
    scanIdentityDocument
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
    const file = uploadedFile(req)

    if (!file) {
        res.status(400).json({
            error: 'invalid_request',
            message: 'Attach the document as `document`'
        } satisfies ErrorResponse)

        return
    }

    const documentType = identityDocumentTypeSchema.safeParse(
        (req.body as { documentType?: unknown })?.documentType
    )

    if (!documentType.success) {
        res.status(400).json({
            error: 'invalid_request',
            message: 'documentType must be drivers_licence or passport'
        } satisfies ErrorResponse)

        return
    }

    try {
        const result = await scanIdentityDocument(transactionId, req.agent.id, partyId, {
            bytes: file.data,
            mimeType: file.mimetype,
            documentType: documentType.data
        })

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
            // The image is already stored — deliberately, so the agent's upload
            // is not lost to a reader outage and the record can be completed by
            // hand. What did not happen is the reading.
            logger.warn('identity scan failed', { transactionId, kind: error.kind })

            if (error.kind === 'unreadable') {
                res.status(422).json({
                    error: 'document_unreadable',
                    message:
                        'No identity document could be read from that image. Try a straight-on photo in good light.'
                } satisfies ErrorResponse)

                return
            }

            res.status(502).json({
                error: 'ocr_unavailable',
                message: 'The document reader is unavailable right now. Try again in a moment.'
            } satisfies ErrorResponse)

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
