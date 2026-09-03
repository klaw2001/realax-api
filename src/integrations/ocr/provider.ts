/**
 * The identity-document OCR boundary (build plan 2.5).
 *
 * `integrations/` holds the shapes we do not control, so that swapping a vendor
 * touches one folder. This file is the part that does not change when one is
 * swapped: what we ask for, and what we expect back. `textract.client.ts` is
 * one implementation of it.
 *
 * The build plan called for the interface to exist before the vendor was
 * chosen. The vendor is Textract now, and the interface stays anyway — it is
 * what keeps a vendor's field naming out of the domain model.
 */

/**
 * The kinds of document the product accepts.
 *
 * Narrow on purpose. FINTRAC's methods name particular documents, and a scan of
 * something not on the list is not a verification however well it OCRs.
 */
export type IdentityDocumentType = 'drivers_licence' | 'passport'

/** One scan to read. */
export interface ScanRequest {
    /**
     * The object to read, already in our own bucket.
     *
     * A key rather than bytes: the file is uploaded, stored under Object Lock
     * and only then read, so the record and the document it came from cannot
     * end up describing different files. It also keeps the image out of this
     * process's memory a second time.
     */
    s3Key: string

    /** What the agent said it is. Used to sanity-check what comes back. */
    declaredType: IdentityDocumentType
}

/**
 * What a scan yields, in our vocabulary rather than a vendor's.
 *
 * Every field is optional except the confidence: OCR of a photographed card is
 * a best effort, and a provider returning nine of ten fields is the normal
 * case. The agent confirms and corrects before anything is saved — this is a
 * head start on typing, not an authority.
 */
export interface ScannedIdentity {
    documentType: IdentityDocumentType | null

    /** As printed. Not split — the form wants the full legal name. */
    fullName: string | null
    firstName: string | null
    middleName: string | null
    lastName: string | null

    /** `YYYY-MM-DD`, or null when the provider could not normalise the date. */
    dateOfBirth: string | null
    expiryDate: string | null
    dateOfIssue: string | null

    /**
     * The licence or passport number.
     *
     * The one field on this object that is FINTRAC material in its own right.
     * It is encrypted before it reaches a column and is never logged, never put
     * in an error message, and never returned to the frontend.
     */
    documentNumber: string | null

    address: string | null
    city: string | null
    province: string | null
    postalCode: string | null

    /**
     * The provider's lowest confidence across the fields it did return, 0–100.
     *
     * One number rather than per field, because it is used for one thing:
     * deciding how loudly to ask the agent to check the result.
     */
    confidence: number

    /** Vendor and model, recorded on the audit trail. */
    provider: string
    modelVersion: string | null
}

export interface OcrProvider {
    readonly name: string

    /** Read one identity document. Throws `OcrError` on anything unusable. */
    scanIdentityDocument(request: ScanRequest): Promise<ScannedIdentity>
}

/**
 * An OCR call that did not produce a usable answer.
 *
 * `kind` separates the three cases a caller treats differently:
 *
 * - `unreadable` — the provider worked and found no document in the image.
 *   The agent's to fix, by taking a better photo, and not an error at all as
 *   far as the service is concerned: it stores the image and hands back an
 *   empty form to type into.
 * - `unavailable` — the provider is unreachable, throttled, or having an
 *   outage. Transient. Worth retrying in a moment, and that is what the agent
 *   is told.
 * - `misconfigured` — the provider is reachable and is refusing us: a missing
 *   or wrong key, a subscription the account does not have, a model that is
 *   not enabled. **No amount of retrying fixes this**, and telling an agent to
 *   try again in a moment sends them round a loop that cannot end. It is the
 *   shape of the failure this project actually hit — Textract answering every
 *   call with `SubscriptionRequiredException` on a Free-plan AWS account —
 *   which is why it is a kind of its own rather than a flavour of
 *   `unavailable`.
 */
export class OcrError extends Error {
    constructor(
        readonly kind: 'unavailable' | 'unreadable' | 'misconfigured',
        message: string,
        readonly cause?: unknown
    ) {
        super(message)
        this.name = 'OcrError'
    }
}
