import { createHash } from 'node:crypto'

import type { OcrProvider, ScannedIdentity as RawScan } from '@/integrations/ocr/provider'
import { ocrProvider } from '@/integrations/ocr/textract.client'
import { encryptField } from '@/lib/encryption'
import logger from '@/lib/logger'
import prisma from '@/lib/prisma'
import { keys, putObject } from '@/lib/s3'
import { TransactionNotFoundError } from '@/modules/transaction/transaction.service'
import type {
    IdentityDocumentType,
    IdentityRecord,
    ScanIdentityResponse,
    ScannedIdentity
} from '@/schemas/identity'

/**
 * Identity documents (build plan 2.5).
 *
 * The flow, in this order and for a reason: store the image, read the stored
 * image, write the record. Storing first means the `IdentityRecord` is provably
 * about the object sitting in the bucket under Object Lock, rather than about
 * some bytes that were in memory when a request came in. A FINTRAC record whose
 * document cannot be produced later is not a record.
 *
 * The document number is encrypted the moment it exists and is never returned,
 * never logged, and never put in an error message. Everything in this module is
 * arranged so that reaching it takes deliberate effort rather than a `SELECT *`.
 */

/** Below this, the agent should read every field rather than skim. */
const LOW_CONFIDENCE = 90

/** What we accept. Anything else is a scan of something that is not identity. */
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png'])

const EXTENSION: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png'
}

export class UnsupportedDocumentError extends Error {
    constructor(detail: string) {
        super(detail)
        this.name = 'UnsupportedDocumentError'
    }
}

export class PartyNotFoundError extends Error {
    constructor() {
        super('No such party on this transaction')
        this.name = 'PartyNotFoundError'
    }
}

/**
 * The party, if it is live on a transaction the caller owns.
 *
 * The four conditions are one query: a party on someone else's transaction, a
 * removed party, a party that never existed and a transaction that never
 * existed are one answer, and none of them is distinguishable to the caller.
 */
const ownedParty = async (transactionId: string, agentId: string, partyId: string) => {
    const transaction = await prisma.transaction.findFirst({
        where: { id: transactionId, agentId },
        select: { id: true }
    })

    if (!transaction) {
        throw new TransactionNotFoundError()
    }

    const party = await prisma.transactionParty.findFirst({
        where: { id: partyId, transactionId, deletedAt: null },
        select: { partyId: true }
    })

    if (!party) {
        throw new PartyNotFoundError()
    }

    return party.partyId
}

/** A stored record as the API publishes it — which is to say, without the number. */
const toIdentityRecord = (record: {
    id: string
    partyId: string
    documentType: string
    documentNumber: string
    expiryDate: Date | null
    verifiedAt: Date
    verifiedMethod: string
}): IdentityRecord => ({
    id: record.id,
    partyId: record.partyId,
    documentType: record.documentType as IdentityDocumentType,

    // Whether one is held, not what it is. There is no code path in this
    // service that puts a document number into a response.
    documentNumberOnFile: record.documentNumber !== '',

    expiryDate: record.expiryDate === null ? null : record.expiryDate.toISOString().slice(0, 10),
    verifiedAt: record.verifiedAt.toISOString(),
    verifiedMethod: record.verifiedMethod,
    expired: record.expiryDate !== null && record.expiryDate.getTime() < Date.now()
})

/** A raw provider result as the frontend sees it: the number replaced by whether there was one. */
const toScannedResponse = (scan: RawScan): ScannedIdentity => ({
    documentType: scan.documentType,
    fullName: scan.fullName,
    firstName: scan.firstName,
    middleName: scan.middleName,
    lastName: scan.lastName,
    dateOfBirth: scan.dateOfBirth,
    expiryDate: scan.expiryDate,
    address: scan.address,
    city: scan.city,
    province: scan.province,
    postalCode: scan.postalCode,
    documentNumberRead: scan.documentNumber !== null,
    confidence: scan.confidence,
    lowConfidence: scan.confidence < LOW_CONFIDENCE
})

export interface ScanUpload {
    bytes: Buffer
    mimeType: string
    documentType: IdentityDocumentType
}

/**
 * Store, read, and record one identity document.
 *
 * `provider` is a parameter with a default rather than a module-level import so
 * the tests can pass a stub. Nothing calls Textract in the suite: an OCR call
 * against a real driver's licence is billed, slow, and needs a real driver's
 * licence, none of which belongs in `npm test`.
 */
export const scanIdentityDocument = async (
    transactionId: string,
    agentId: string,
    transactionPartyId: string,
    upload: ScanUpload,
    provider: OcrProvider = ocrProvider()
): Promise<ScanIdentityResponse> => {
    const personId = await ownedParty(transactionId, agentId, transactionPartyId)

    if (!ACCEPTED_MIME.has(upload.mimeType)) {
        throw new UnsupportedDocumentError('An identity document must be a JPEG or a PNG')
    }

    // Stored before it is read, so the record that results is about the object
    // under Object Lock rather than about bytes that passed through here. The
    // key convention is the one in `lib/s3.ts`; nothing builds a key by hand.
    const s3Key = keys.identityDocument(
        transactionId,
        personId,
        upload.documentType,
        EXTENSION[upload.mimeType]
    )

    await putObject({ key: s3Key, body: upload.bytes, contentType: upload.mimeType })

    const scan = await provider.scanIdentityDocument({
        s3Key,
        declaredType: upload.documentType
    })

    // Encrypted the moment it exists, and the plaintext is not held in a
    // variable beyond this expression. An empty string when nothing was read:
    // the column is not nullable, and "" is distinguishable from a ciphertext
    // in a way that a plaintext placeholder would not be.
    const documentNumber =
        scan.documentNumber === null ? '' : encryptField(scan.documentNumber)

    const record = await prisma.identityRecord.create({
        data: {
            partyId: personId,
            documentType: upload.documentType,
            documentNumber,
            expiryDate: scan.expiryDate === null ? null : new Date(`${scan.expiryDate}T00:00:00.000Z`),
            verifiedAt: new Date(),

            // The FINTRAC method this satisfies. Recorded as what was done
            // rather than left implicit — the method is the thing an examiner
            // asks about, not the vendor.
            verifiedMethod: 'government_photo_id',
            s3Key
        },
        select: {
            id: true,
            partyId: true,
            documentType: true,
            documentNumber: true,
            expiryDate: true,
            verifiedAt: true,
            verifiedMethod: true
        }
    })

    await prisma.document.create({
        data: {
            transactionId,
            kind: 'id_scan',
            s3Key,
            sha256: createHash('sha256').update(upload.bytes).digest('hex')
        }
    })

    // Ids and outcomes. Never the party's name, never the number, never the
    // key — CLAUDE.md rule 6 names all three.
    logger.info('identity document recorded', {
        transactionId,
        recordId: record.id,
        documentType: upload.documentType,
        numberRead: scan.documentNumber !== null,
        confidence: Math.round(scan.confidence)
    })

    return {
        scanned: toScannedResponse(scan),
        record: toIdentityRecord(record)
    }
}

/**
 * The records held for a party.
 *
 * Keyed on the person rather than on this transaction's row for them, which is
 * the reuse build plan 2.5 is for: somebody verified on a previous deal is
 * already verified on this one, and asking them for their licence twice is the
 * thing the product is meant to stop.
 */
export const listPartyIdentityRecords = async (
    transactionId: string,
    agentId: string,
    transactionPartyId: string
): Promise<IdentityRecord[]> => {
    const personId = await ownedParty(transactionId, agentId, transactionPartyId)

    const records = await prisma.identityRecord.findMany({
        where: { partyId: personId },
        orderBy: { verifiedAt: 'desc' },
        select: {
            id: true,
            partyId: true,
            documentType: true,
            documentNumber: true,
            expiryDate: true,
            verifiedAt: true,
            verifiedMethod: true

            // `s3Key` is not selected. Nothing that reads a record needs it,
            // and a key that is never loaded is a key that cannot be logged.
        }
    })

    return records.map(toIdentityRecord)
}
