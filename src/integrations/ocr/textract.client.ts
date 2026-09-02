import {
    AnalyzeIDCommand,
    TextractClient,
    type AnalyzeIDResponse,
    type IdentityDocumentField
} from '@aws-sdk/client-textract'

import { env } from '@/config/env'
import logger from '@/lib/logger'
import {
    OcrError,
    type IdentityDocumentType,
    type OcrProvider,
    type ScanRequest,
    type ScannedIdentity
} from '@/integrations/ocr/provider'

/**
 * Amazon Textract `AnalyzeID` (build plan 2.5).
 *
 * Runs in `ca-central-1`, the same region as the bucket. That is not a default
 * — identity documents are FINTRAC material and do not leave Canada, including
 * to be read. AnalyzeID is available in that region; it was confirmed before
 * this file was written, and if it is ever moved the region must be checked
 * again rather than falling back to a US one.
 *
 * The document is passed by S3 key, not by bytes. Textract reads it out of our
 * own bucket, which means the image is not copied into this process a second
 * time and the record that results is provably about the object under Object
 * Lock rather than about some bytes that were in memory at the time.
 *
 * ## Two caveats worth knowing before trusting this
 *
 * **The model is trained on US documents.** AWS documents AnalyzeID's support
 * as US driver's licences and US passports. It runs against an Ontario licence
 * and returns fields, but the extraction quality on Canadian documents is not
 * something AWS commits to. Everything here is therefore written to survive a
 * partial result: every field is optional, nothing is asserted, and the agent
 * confirms the values before an `IdentityRecord` is written. See NEEDS-KLAW —
 * this is a product question, not a coding one.
 *
 * **The response shape comes from the SDK, not from prose.** This repo's rule
 * is never to invent an external API's shape from documentation, and this does
 * not: `AnalyzeIDResponse` is the vendor's own type, versioned with the client,
 * so a change to it is a compile error here. What the SDK does *not* type is
 * the set of strings that appear in `Type.Text` — those are model output. So
 * they are matched leniently and anything unrecognised is ignored rather than
 * treated as a schema violation, which is the opposite of how the Repliers
 * client is written and deliberately so: Repliers returning an unexpected shape
 * means our schema is wrong, whereas a new field name from an OCR model means
 * the model got better.
 */

/**
 * One client, at module scope.
 *
 * Credentials come from the SDK's default chain, the same as S3 — environment
 * variables locally, an instance role in production.
 */
let client: TextractClient | null = null

const textract = (): TextractClient => {
    client ??= new TextractClient({ region: env.OCR_REGION })

    return client
}

/**
 * The normalised field names AnalyzeID emits that this product has a use for.
 *
 * Not exhaustive, and not meant to be: AnalyzeID also returns endorsements,
 * restrictions, licence class and veteran status, none of which any OREA form
 * or FINTRAC method asks for. Storing a client's licence restrictions because
 * a vendor happened to return them is how a system ends up holding data it
 * cannot justify.
 */
const FIELD = {
    FIRST_NAME: 'firstName',
    MIDDLE_NAME: 'middleName',
    LAST_NAME: 'lastName',
    DOCUMENT_NUMBER: 'documentNumber',
    DATE_OF_BIRTH: 'dateOfBirth',
    EXPIRATION_DATE: 'expiryDate',
    DATE_OF_ISSUE: 'dateOfIssue',
    ADDRESS: 'address',
    CITY_IN_ADDRESS: 'city',
    STATE_IN_ADDRESS: 'province',
    ZIP_CODE_IN_ADDRESS: 'postalCode',
    ID_TYPE: 'idType'
} as const

type FieldKey = (typeof FIELD)[keyof typeof FIELD]

/** Trimmed, or null. Textract returns an empty string for a field it did not find. */
const text = (value: string | undefined): string | null => {
    const trimmed = value?.trim() ?? ''

    return trimmed === '' ? null : trimmed
}

/**
 * A date as the domain carries one: `YYYY-MM-DD`.
 *
 * Taken from `NormalizedValue` when Textract supplied one — it is an ISO
 * instant there — and otherwise from the printed text, which on a card is
 * `MM/DD/YYYY` on a US document and `YYYY/MM/DD` on an Ontario one. Those two
 * are not distinguishable for the first twelve days of a month, so an
 * ambiguous printed date is returned as null rather than guessed at. A birth
 * date that is wrong by a month on a FINTRAC record is worse than a blank one
 * the agent fills in.
 */
const asDate = (field: { normalized?: string; printed: string | null }): string | null => {
    if (field.normalized) {
        const match = /^(\d{4}-\d{2}-\d{2})/.exec(field.normalized)

        if (match) {
            return match[1]
        }
    }

    const printed = field.printed

    if (printed === null) {
        return null
    }

    // Unambiguous: a four-digit year first.
    const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(printed)

    if (iso) {
        const [, year, month, day] = iso

        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    }

    return null
}

/** `ID_TYPE` as one of ours, or null when it is something we do not accept. */
const asDocumentType = (value: string | null): IdentityDocumentType | null => {
    if (value === null) {
        return null
    }

    const normalised = value.toLowerCase()

    if (normalised.includes('passport')) {
        return 'passport'
    }

    if (normalised.includes('license') || normalised.includes('licence')) {
        return 'drivers_licence'
    }

    return null
}

interface Detected {
    printed: string | null
    normalized?: string
    confidence: number | null
}

/**
 * The first document in the response, as a map of the fields we care about.
 *
 * "First" because a request carries the front and back of one licence as two
 * pages of one document, not two documents. A response with none is the
 * `unreadable` case.
 */
const detectedFields = (response: AnalyzeIDResponse): Map<FieldKey, Detected> => {
    const document = response.IdentityDocuments?.[0]

    if (!document) {
        throw new OcrError('unreadable', 'No identity document was found in the image')
    }

    const fields = new Map<FieldKey, Detected>()

    for (const field of document.IdentityDocumentFields ?? []) {
        const key = keyFor(field)

        if (key === null) {
            continue
        }

        const printed = text(field.ValueDetection?.Text)

        // A field Textract names but found nothing for is not a field. Keeping
        // it would make `confidence` below the confidence of a blank.
        if (printed === null) {
            continue
        }

        fields.set(key, {
            printed,
            normalized: field.ValueDetection?.NormalizedValue?.Value,
            confidence: field.ValueDetection?.Confidence ?? null
        })
    }

    return fields
}

/** The field's name in our vocabulary, or null for one we have no use for. */
const keyFor = (field: IdentityDocumentField): FieldKey | null => {
    const type = field.Type?.Text?.trim().toUpperCase()

    if (type === undefined) {
        return null
    }

    return (FIELD as Record<string, FieldKey | undefined>)[type] ?? null
}

/**
 * The lowest confidence across the fields that were found, or 0 when nothing
 * was.
 *
 * The lowest rather than the mean: a result where nine fields are certain and
 * the licence number is a guess is a result to check, and averaging hides
 * exactly the field it matters most about.
 */
const lowestConfidence = (fields: Map<FieldKey, Detected>): number => {
    const scores = [...fields.values()]
        .map(field => field.confidence)
        .filter((score): score is number => score !== null)

    return scores.length === 0 ? 0 : Math.min(...scores)
}

const joinName = (parts: (string | null)[]): string | null => {
    const kept = parts.filter((part): part is string => part !== null && part !== '')

    return kept.length === 0 ? null : kept.join(' ')
}

/** A Textract response as a `ScannedIdentity`. */
export const toScannedIdentity = (
    response: AnalyzeIDResponse,
    declaredType: IdentityDocumentType
): ScannedIdentity => {
    const fields = detectedFields(response)
    const value = (key: FieldKey) => fields.get(key)?.printed ?? null
    const date = (key: FieldKey) => {
        const field = fields.get(key)

        return field ? asDate(field) : null
    }

    const firstName = value('firstName')
    const middleName = value('middleName')
    const lastName = value('lastName')

    return {
        // What Textract read, falling back to what the agent said it was. The
        // two disagreeing is worth surfacing rather than resolving here — the
        // service compares them.
        documentType: asDocumentType(value('idType')) ?? declaredType,

        fullName: joinName([firstName, middleName, lastName]),
        firstName,
        middleName,
        lastName,

        dateOfBirth: date('dateOfBirth'),
        expiryDate: date('expiryDate'),
        dateOfIssue: date('dateOfIssue'),

        documentNumber: value('documentNumber'),

        address: value('address'),
        city: value('city'),
        province: value('province'),
        postalCode: value('postalCode'),

        confidence: lowestConfidence(fields),
        provider: 'textract',
        modelVersion: text(response.AnalyzeIDModelVersion)
    }
}

/** The Textract implementation of the OCR boundary. */
export const textractProvider: OcrProvider = {
    name: 'textract',

    async scanIdentityDocument({ s3Key, declaredType }: ScanRequest): Promise<ScannedIdentity> {
        let response: AnalyzeIDResponse

        try {
            response = await textract().send(
                new AnalyzeIDCommand({
                    DocumentPages: [
                        { S3Object: { Bucket: env.AWS_S3_BUCKET, Name: s3Key } }
                    ]
                })
            )
        } catch (error) {
            // The key is not logged. This one names an identity scan, and rule
            // 6 in CLAUDE.md is that those never reach a log line.
            logger.error('textract analyze-id failed', {
                region: env.OCR_REGION,
                name: (error as Error).name
            })

            throw new OcrError('unavailable', 'The document reader is unavailable', error)
        }

        const scanned = toScannedIdentity(response, declaredType)

        logger.info('identity document read', {
            provider: scanned.provider,
            modelVersion: scanned.modelVersion,
            confidence: Math.round(scanned.confidence),
            // Which fields came back, never what was in them.
            fields: Object.entries(scanned)
                .filter(([, item]) => typeof item === 'string' && item !== '')
                .map(([name]) => name)
                .filter(name => name !== 'documentNumber')
        })

        return scanned
    }
}

/**
 * The configured provider.
 *
 * One name to change, and the enum in `env.ts` makes an unknown one fail on
 * boot rather than at the first upload.
 */
export const ocrProvider = (): OcrProvider => {
    switch (env.OCR_PROVIDER) {
        case 'textract':
            return textractProvider
    }
}

/** Replaces the client. Tests only — nothing in production swaps it. */
export const __setTextractClient = (replacement: TextractClient | null): void => {
    client = replacement
}
