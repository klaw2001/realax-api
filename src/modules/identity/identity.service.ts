import { createHash } from 'node:crypto'

import { OcrError } from '@/integrations/ocr/provider'
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
 * image, hold the reading, and write the record only when an agent has
 * confirmed it. Storing first means the record is provably about the object
 * sitting in the bucket under Object Lock, rather than about some bytes that
 * were in memory when a request came in. A FINTRAC record whose document cannot
 * be produced later is not a record.
 *
 * **Reading a document does not verify anybody.** Textract's AnalyzeID is
 * trained on US identity documents, and an Ontario driver's licence is not one
 * it was verified against — a field can be misread, transposed, or absent while
 * the model reports it confidently. So a scan produces an `IdentityScan`, which
 * is a proposal, and `confirmIdentityScan` turns one into an `IdentityRecord`
 * once a person has checked it against the card. A scan nobody confirms stays a
 * scan; it never becomes a verification that did not happen.
 *
 * The document number is encrypted the moment it exists and is never returned,
 * never logged, and never put in an error message. It moves from the scan row
 * to the record row as ciphertext and is not decrypted on the way. Everything in
 * this module is arranged so that reaching it takes deliberate effort rather
 * than a `SELECT *`.
 */

/** Below this, the agent should read every field rather than skim. */
const LOW_CONFIDENCE = 90

/**
 * The FINTRAC method recorded on a record, and how the values got onto it.
 *
 * Both are the same method — the agent looked at a government photo ID either
 * way, which is the thing an examiner asks about. What the two values separate
 * is provenance: whether any value on the record started as a machine reading,
 * or whether a person typed every one of them off the card.
 *
 * That distinction is the service's to make, never the caller's. It is derived
 * from what the reading actually produced, so a client cannot claim a reading
 * assisted a record it did not assist.
 */
const VERIFIED_METHOD = {
    ocrAssisted: 'government_photo_id',
    manual: 'government_photo_id_manual'
} as const

/** How many fields a reading actually produced. Zero means nothing was read. */
const countFieldsRead = (scan: RawScan): number =>
    [
        scan.documentType,
        scan.fullName,
        scan.firstName,
        scan.middleName,
        scan.lastName,
        scan.dateOfBirth,
        scan.expiryDate,
        scan.dateOfIssue,
        scan.documentNumber,
        scan.address,
        scan.city,
        scan.province,
        scan.postalCode
    ].filter(field => field !== null && field !== '').length

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

export class ScanNotFoundError extends Error {
    constructor() {
        super('No such scan for this party')
        this.name = 'ScanNotFoundError'
    }
}

/**
 * A scan that has already become a record.
 *
 * A conflict rather than a second record: one reading of one document is one
 * event, and confirming it twice — a double-submitted form, a retried request —
 * must not produce two verifications of the same photograph.
 */
export class ScanAlreadyConfirmedError extends Error {
    constructor() {
        super('That scan has already been confirmed')
        this.name = 'ScanAlreadyConfirmedError'
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
 * Store one identity document and read it. Nothing is verified here.
 *
 * The result is an `IdentityScan` — a proposal awaiting a person. The image is
 * stored before it is read, so what comes back describes the object under
 * Object Lock rather than bytes that passed through this process, and the row
 * carries the encrypted number and the file's digest so that confirming needs
 * neither a second Textract call nor a fetch back out of S3.
 *
 * **A reading that produced nothing is still a scan.** An image the reader
 * cannot find a document in is not an error to hand back: the file is stored,
 * the agent has the card in their hand, and the only thing missing is the head
 * start on typing. So `unreadable` becomes a scan with no reading on it — the
 * agent types the document out and confirms it like any other, and the record
 * that results says it was filled by hand.
 *
 * `unavailable` is not treated that way and is still thrown. The reader being
 * unreachable says nothing about the document, and silently turning an outage
 * into a manual-entry form would quietly stop using a service we are paying
 * for. That one is a 502 and worth retrying.
 *
 * `provider` is a parameter with a default rather than a module-level import so
 * the tests can pass a stub. Nothing calls Textract in the suite: an OCR call
 * against a real driver’s licence is billed, slow, and needs a real driver’s
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

    // Stored before it is read, so the record that eventually results is about
    // the object under Object Lock rather than about bytes that passed through
    // here. The key convention is the one in `lib/s3.ts`; nothing builds a key
    // by hand.
    const s3Key = keys.identityDocument(
        transactionId,
        personId,
        upload.documentType,
        EXTENSION[upload.mimeType]
    )

    await putObject({ key: s3Key, body: upload.bytes, contentType: upload.mimeType })

    let scan: RawScan | null = null

    try {
        scan = await provider.scanIdentityDocument({
            s3Key,
            declaredType: upload.documentType
        })
    } catch (error) {
        // The provider worked and found no document. Null here, and the agent
        // gets an empty form to type into rather than an error to work around.
        if (!(error instanceof OcrError) || error.kind !== 'unreadable') {
            throw error
        }
    }

    // Encrypted the moment it exists, and the plaintext is not held in a
    // variable beyond this expression. An empty string when nothing was read:
    // the column is not nullable, and "" is distinguishable from a ciphertext
    // in a way that a plaintext placeholder would not be.
    //
    // It is written here and copied to the record as ciphertext at confirm
    // time. Nothing between the two calls decrypts it.
    const documentNumber =
        scan === null || scan.documentNumber === null ? '' : encryptField(scan.documentNumber)

    const fieldsRead = scan === null ? 0 : countFieldsRead(scan)

    const pending = await prisma.identityScan.create({
        data: {
            transactionId,
            partyId: personId,
            documentType: upload.documentType,
            documentNumber,
            expiryDate:
                scan === null || scan.expiryDate === null
                    ? null
                    : new Date(`${scan.expiryDate}T00:00:00.000Z`),
            s3Key,

            // Of the bytes as uploaded, so the `Document` row written at
            // confirm time describes the file rather than a re-read of it.
            sha256: createHash('sha256').update(upload.bytes).digest('hex'),

            // Zero for an image nothing could be read from, which is what the
            // confirm step reads to know the record was typed rather than read.
            confidence: scan?.confidence ?? 0,
            fieldsRead
        },
        select: { id: true }
    })

    // Ids and outcomes. Never the party’s name, never the number, never the
    // key — CLAUDE.md rule 6 names all three.
    logger.info('identity document read, awaiting confirmation', {
        transactionId,
        scanId: pending.id,
        documentType: upload.documentType,
        fieldsRead,
        numberRead: scan?.documentNumber != null,
        confidence: Math.round(scan?.confidence ?? 0)
    })

    return {
        scanId: pending.id,

        // Null rather than a shape full of nulls: there was no reading, and a
        // reading that found nothing and one that never happened are different
        // things to tell an agent about.
        scanned: scan === null ? null : toScannedResponse(scan)
    }
}

/** What the agent checked against the card, and is willing to stand behind. */
export interface ConfirmedIdentity {
    documentType: IdentityDocumentType

    /** `YYYY-MM-DD`, or null for a document with no expiry the agent could give. */
    expiryDate: string | null
}

/**
 * Turn a reading into a record, on an agent’s say-so.
 *
 * This is the only place an `IdentityRecord` is created. The values written are
 * the agent’s, not the model’s — the two differ exactly when OCR got something
 * wrong, which is the case this whole split exists for. What is carried over
 * unchanged is the encrypted number and the object it was read from: the agent
 * confirms what the document says, not which file it was.
 *
 * `verifiedMethod` records which of the two happened. A scan the reader
 * produced nothing from confirms just as well, and the record says it was
 * typed by hand rather than read.
 *
 * One database transaction, because a record without its `Document` row is a
 * verification whose evidence is not indexed, and a scan marked confirmed with
 * no record is a scan that can never be confirmed.
 */
export const confirmIdentityScan = async (
    transactionId: string,
    agentId: string,
    transactionPartyId: string,
    scanId: string,
    confirmed: ConfirmedIdentity
): Promise<IdentityRecord> => {
    const personId = await ownedParty(transactionId, agentId, transactionPartyId)

    // Scoped to the transaction *and* the person: a scan id from another deal
    // is not found here rather than confirmable from the wrong screen.
    const pending = await prisma.identityScan.findFirst({
        where: { id: scanId, transactionId, partyId: personId },
        select: {
            id: true,
            documentNumber: true,
            s3Key: true,
            sha256: true,
            fieldsRead: true,
            confirmedAt: true
        }
    })

    if (!pending) {
        throw new ScanNotFoundError()
    }

    if (pending.confirmedAt !== null) {
        throw new ScanAlreadyConfirmedError()
    }

    const verifiedAt = new Date()

    const record = await prisma.$transaction(async tx => {
        const created = await tx.identityRecord.create({
            data: {
                partyId: personId,
                documentType: confirmed.documentType,

                // Ciphertext, moved rather than re-encrypted. Decrypting it to
                // write it again would put a licence number in a variable for
                // no reason at all.
                documentNumber: pending.documentNumber,

                expiryDate:
                    confirmed.expiryDate === null
                        ? null
                        : new Date(`${confirmed.expiryDate}T00:00:00.000Z`),
                verifiedAt,

                // The FINTRAC method this satisfies, and how it was filled.
                // Recorded as what was done rather than left implicit — the
                // method is the thing an examiner asks about, not the vendor.
                //
                // Derived from the reading, not taken from the request: a
                // record where the model produced nothing was typed off the
                // card by a person, and that is worth being able to tell
                // apart later. A null `fieldsRead` is a row written before the
                // column existed, and back then a scan only existed when a
                // reading had succeeded.
                verifiedMethod:
                    (pending.fieldsRead ?? 1) > 0
                        ? VERIFIED_METHOD.ocrAssisted
                        : VERIFIED_METHOD.manual,
                s3Key: pending.s3Key
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

        await tx.document.create({
            data: {
                transactionId,
                kind: 'id_scan',
                s3Key: pending.s3Key,
                sha256: pending.sha256
            }
        })

        // Marked with what it became, so an unconfirmed row is visibly
        // unconfirmed and this one cannot be confirmed a second time.
        await tx.identityScan.update({
            where: { id: pending.id },
            data: { confirmedAt: verifiedAt, recordId: created.id }
        })

        return created
    })

    logger.info('identity document confirmed', {
        transactionId,
        scanId: pending.id,
        recordId: record.id,
        documentType: confirmed.documentType,
        verifiedMethod: record.verifiedMethod
    })

    return toIdentityRecord(record)
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
