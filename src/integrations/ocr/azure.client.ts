import DocumentIntelligence, {
    getLongRunningPoller,
    isUnexpected,
    type AnalyzeOperationOutput,
    type AnalyzedDocumentOutput,
    type DocumentFieldOutput,
    type DocumentIntelligenceClient
} from '@azure-rest/ai-document-intelligence'

import { env } from '@/config/env'
import logger from '@/lib/logger'
import { getObjectBytes } from '@/lib/s3'
import {
    OcrError,
    type IdentityDocumentType,
    type OcrProvider,
    type ScanRequest,
    type ScannedIdentity
} from '@/integrations/ocr/provider'

/**
 * Azure AI Document Intelligence `prebuilt-idDocument` — the development and
 * demo reader.
 *
 * **Textract is the production reader.** This exists because the project's AWS
 * account is on the new Free plan, where Textract is a Paid-plan service and
 * every `AnalyzeID` call returns `SubscriptionRequiredException` in every
 * region. Azure's F0 tier reads 500 pages a month for nothing, which is enough
 * to build and demo against. `textract.client.ts` is untouched and stays the
 * default; `OCR_PROVIDER` chooses, and `env.ts` refuses anything but Textract
 * when `NODE_ENV` is production.
 *
 * ## Why this one rather than the cheaper options
 *
 * It is the only free reader that returns *typed identity fields* rather than
 * a page of text to parse, so what is seen in development is close to what
 * Textract will do — and it can run in Canada Central, which matters because
 * identity documents are FINTRAC material and the rest of this system is built
 * so they do not leave the country. Point `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
 * at a Canadian resource; nothing here enforces that, and it should be checked
 * when the account is created.
 *
 * ## Bytes, not a bucket reference
 *
 * Textract reads the object out of our own S3 bucket, which is why
 * `ScanRequest` carries a key. Azure cannot see that bucket, so the object is
 * fetched and posted as base64. The document is therefore in this process's
 * memory for the length of the call — acceptable for a development reader,
 * and one more reason production stays on Textract. The key still identifies
 * the object under Object Lock, so the record and the file cannot drift apart.
 *
 * ## Two caveats
 *
 * **F0 caps a request at 4 MB.** The client already refuses over 5 MB, so an
 * image between the two is possible; that case is reported as `unreadable`
 * with the size named, because it is fixed by taking a smaller photo.
 *
 * **The field names are model output, not a typed contract.** The SDK types
 * the envelope — `AnalyzeOperationOutput`, `DocumentFieldOutput` — and those
 * are versioned with the package, so a change to them is a compile error here.
 * What it does not type is the set of keys inside `fields`, which is the
 * model's own schema for `prebuilt-idDocument`. They are therefore read
 * leniently and anything unrecognised is ignored, exactly as the Textract
 * client treats `Type.Text`. The mapping below is written from Azure's
 * documented schema and **has not yet been checked against a real response** —
 * verify it against one once the account exists, and correct it there rather
 * than papering over a miss in the service.
 */

let client: DocumentIntelligenceClient | null = null

const azure = (): DocumentIntelligenceClient => {
    // Non-null asserted rather than defaulted: `env.ts` refuses to boot with
    // `OCR_PROVIDER=azure` and either variable missing, so reaching this line
    // without them is impossible.
    client ??= DocumentIntelligence(env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT!, {
        key: env.AZURE_DOCUMENT_INTELLIGENCE_KEY!
    })

    return client
}

/** The model. Prebuilt, so there is nothing to train and nothing to version. */
const MODEL_ID = 'prebuilt-idDocument'

/** F0's per-request ceiling. Larger is a 4xx from Azure, so it is caught here. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024

/**
 * The fields this product has a use for, keyed by the model's own name for
 * them.
 *
 * Deliberately short. `prebuilt-idDocument` also returns height, weight, eye
 * colour, hair colour, endorsements, restrictions and vehicle classifications,
 * none of which any OREA form or FINTRAC method asks for. Reading them because
 * a vendor returned them is how a system ends up holding data it cannot
 * justify.
 */
const FIELD = {
    FirstName: 'firstName',
    MiddleName: 'middleName',
    LastName: 'lastName',
    DocumentNumber: 'documentNumber',
    DateOfBirth: 'dateOfBirth',
    DateOfExpiration: 'expiryDate',
    DateOfIssue: 'dateOfIssue'
} as const

type FieldKey = (typeof FIELD)[keyof typeof FIELD]

const text = (value: string | undefined): string | null => {
    const trimmed = value?.trim() ?? ''

    return trimmed === '' ? null : trimmed
}

/**
 * A field's string value.
 *
 * `valueString` when the model normalised one, `content` — what was printed —
 * otherwise. A field the model named but read nothing into is not a field.
 */
const asText = (field: DocumentFieldOutput | undefined): string | null =>
    field === undefined ? null : text(field.valueString) ?? text(field.content)

/**
 * A date as the domain carries one: `YYYY-MM-DD`.
 *
 * `valueDate` is already ISO by the SDK's own contract. When the model could
 * not normalise the printed date it is left null rather than guessed at:
 * `03/04/1985` is two different birthdays depending on the issuing country,
 * and a FINTRAC record wrong by a month is worse than a blank the agent fills.
 */
const asDate = (field: DocumentFieldOutput | undefined): string | null => {
    if (field?.valueDate === undefined) {
        return null
    }

    const match = /^(\d{4}-\d{2}-\d{2})/.exec(field.valueDate)

    return match ? match[1] : null
}

/**
 * The address, split.
 *
 * `valueAddress` is the model's parse of it and is preferred; `content` is the
 * printed block, kept as the street line when there is no parse, because a
 * single string in the street field is still a head start on typing.
 */
const asAddress = (field: DocumentFieldOutput | undefined) => {
    const parsed = field?.valueAddress

    if (parsed === undefined) {
        return {
            address: asText(field),
            city: null,
            province: null,
            postalCode: null
        }
    }

    return {
        address: text(parsed.streetAddress) ?? asText(field),
        city: text(parsed.city),
        province: text(parsed.state),
        postalCode: text(parsed.postalCode)
    }
}

/** `docType` as one of ours, or null for something we do not accept. */
const asDocumentType = (docType: string | undefined): IdentityDocumentType | null => {
    const normalised = docType?.toLowerCase() ?? ''

    if (normalised.includes('passport')) {
        return 'passport'
    }

    if (normalised.includes('license') || normalised.includes('licence')) {
        return 'drivers_licence'
    }

    return null
}

/**
 * The lowest confidence across the fields that were read, 0–100.
 *
 * Azure scores 0–1 where Textract scores 0–100, so it is scaled here — the
 * domain's `confidence` means one thing whichever reader produced it. Lowest
 * rather than mean, for the same reason as the Textract client: a result where
 * nine fields are certain and the licence number is a guess is a result to
 * check, and averaging hides the field it matters most about.
 */
const lowestConfidence = (fields: DocumentFieldOutput[]): number => {
    const scores = fields
        .map(field => field.confidence)
        .filter((score): score is number => typeof score === 'number')

    return scores.length === 0 ? 0 : Math.min(...scores) * 100
}

const joinName = (parts: (string | null)[]): string | null => {
    const kept = parts.filter((part): part is string => part !== null && part !== '')

    return kept.length === 0 ? null : kept.join(' ')
}

/**
 * The first document in the result.
 *
 * "First" because a request carries the front and back of one card as two
 * pages of one document, not two documents. None is the `unreadable` case —
 * the reader worked and found no identity document in the image, which is the
 * agent's to fix with a better photograph.
 */
const firstDocument = (operation: AnalyzeOperationOutput): AnalyzedDocumentOutput => {
    const document = operation.analyzeResult?.documents?.[0]

    if (!document) {
        throw new OcrError('unreadable', 'No identity document was found in the image')
    }

    return document
}

/** An Azure analyse result as a `ScannedIdentity`. */
export const toScannedIdentity = (
    operation: AnalyzeOperationOutput,
    declaredType: IdentityDocumentType
): ScannedIdentity => {
    const document = firstDocument(operation)
    const raw = document.fields ?? {}

    // Only the names we asked for. An unrecognised key is a model that got
    // better, not a schema violation — the opposite of how the Repliers client
    // is written, and deliberately so.
    const wanted = new Map<FieldKey, DocumentFieldOutput>()

    for (const [name, key] of Object.entries(FIELD) as [string, FieldKey][]) {
        const field = raw[name]

        if (field !== undefined) {
            wanted.set(key, field)
        }
    }

    const firstName = asText(wanted.get('firstName'))
    const middleName = asText(wanted.get('middleName'))
    const lastName = asText(wanted.get('lastName'))

    const { address, city, province, postalCode } = asAddress(raw.Address)

    // Address is scored too, and a badly-read address is worth flagging.
    const scored = [...wanted.values()]

    if (raw.Address !== undefined) {
        scored.push(raw.Address)
    }

    return {
        // What the model read, falling back to what the agent said it is. The
        // two disagreeing is for the service to surface, not for this file to
        // resolve.
        documentType: asDocumentType(document.docType) ?? declaredType,

        fullName: joinName([firstName, middleName, lastName]),
        firstName,
        middleName,
        lastName,

        dateOfBirth: asDate(wanted.get('dateOfBirth')),
        expiryDate: asDate(wanted.get('expiryDate')),
        dateOfIssue: asDate(wanted.get('dateOfIssue')),

        documentNumber: asText(wanted.get('documentNumber')),

        address,
        city,
        province,
        postalCode,

        confidence: lowestConfidence(scored),
        provider: 'azure',
        modelVersion: text(operation.analyzeResult?.apiVersion)
    }
}

/** The Azure implementation of the OCR boundary. */
export const azureProvider: OcrProvider = {
    name: 'azure',

    async scanIdentityDocument({ s3Key, declaredType }: ScanRequest): Promise<ScannedIdentity> {
        let bytes: Buffer

        try {
            bytes = await getObjectBytes(s3Key)
        } catch (error) {
            // The key names an identity scan and rule 6 keeps those out of logs.
            logger.error('azure id read: could not fetch the stored document', {
                name: (error as Error).name
            })

            throw new OcrError('unavailable', 'The document reader is unavailable', error)
        }

        if (bytes.byteLength > MAX_REQUEST_BYTES) {
            // Not `unavailable`: retrying sends the same bytes. A smaller photo
            // fixes it, and that is the agent's to do.
            throw new OcrError(
                'unreadable',
                `That image is ${Math.round(bytes.byteLength / 1024 / 1024)} MB; the reader accepts up to 4 MB`
            )
        }

        let operation: AnalyzeOperationOutput

        try {
            const initial = await azure()
                .path('/documentModels/{modelId}:analyze', MODEL_ID)
                .post({
                    contentType: 'application/json',
                    body: { base64Source: bytes.toString('base64') }
                })

            if (isUnexpected(initial)) {
                // 401/403 is the resource answering that this key may not do
                // this — wrong key, wrong endpoint, or the model not enabled on
                // the tier. No retry fixes any of those, so it is not reported
                // as an outage.
                if (initial.status === '401' || initial.status === '403') {
                    throw new OcrError(
                        'misconfigured',
                        'The document reader refused the request; its key or endpoint is wrong'
                    )
                }

                throw new Error(initial.body.error?.code ?? 'analyze rejected')
            }

            const poller = getLongRunningPoller(azure(), initial)
            const settled = await poller.pollUntilDone()

            operation = settled.body as AnalyzeOperationOutput
        } catch (error) {
            const misconfigured = error instanceof OcrError && error.kind === 'misconfigured'

            logger.error('azure analyze id-document failed', {
                endpointHost: hostOf(env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT),
                name: (error as Error).name,
                kind: misconfigured ? 'misconfigured' : 'unavailable'
            })

            // Thrown by the 401/403 branch above and already classified. It
            // passes through rather than being flattened into an outage.
            if (misconfigured) {
                throw error
            }

            throw new OcrError('unavailable', 'The document reader is unavailable', error)
        }

        if (operation.status !== 'succeeded') {
            logger.error('azure analyze id-document did not succeed', {
                status: operation.status
            })

            throw new OcrError('unavailable', 'The document reader is unavailable')
        }

        const scanned = toScannedIdentity(operation, declaredType)

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

/** The endpoint's host, for a log line. Never the key, never the path. */
const hostOf = (endpoint: string | undefined): string | null => {
    if (endpoint === undefined) {
        return null
    }

    try {
        return new URL(endpoint).host
    } catch {
        return null
    }
}

/** Replaces the client. Tests only — nothing in production swaps it. */
export const __setAzureClient = (replacement: DocumentIntelligenceClient | null): void => {
    client = replacement
}
