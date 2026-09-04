/**
 * The e-sign boundary (build plan phase 3).
 *
 * `integrations/` holds the shapes we do not control, so swapping a vendor
 * touches one folder. This file is the part that does not change when one is:
 * what we ask for, and what we expect back, in our vocabulary rather than
 * signNow's. `signnow.client.ts` is one implementation.
 *
 * Every shape here was chosen against captured responses, not documentation —
 * see `test/fixtures/signnow/README.md` for what the documentation would have
 * got wrong.
 */

/** One party who has to sign, as this codebase thinks of them. */
export interface EnvelopeSigner {
    /**
     * Our `TransactionParty` id.
     *
     * Never sent to the vendor. It is how a callback is matched back to a party
     * without keeping the party's email on the envelope row.
     */
    transactionPartyId: string

    email: string

    /**
     * As printed on the form. Used only to pre-fill the signature box, and
     * deliberately not stored on `SigningEnvelope` — rule 6.
     */
    fullLegalName: string

    /**
     * Dense, starting at 1.
     *
     * This is the invite's `order`, which is what actually gates sequential
     * signing: 1 signs, and only then is 2 invited. The role's own
     * `signing_order` defaults to "1" for everybody and is not it.
     */
    order: number

    role: 'BUYER' | 'SELLER' | 'SPOUSE' | 'WITNESS'
}

/**
 * Where one signing box goes, in **our** coordinate space.
 *
 * Straight off a curated template in `forms/templates/`: PDF user space, origin
 * bottom-left, y increasing upward, `bbox` as `[x0, y0, x1, y1]`, `page`
 * counting from 1. Converting to whatever the vendor measures from is the
 * client's job, not the caller's — signNow happens to use top-left and
 * zero-indexed pages, and that fact should not leak up here.
 */
export interface FieldPlacement {
    /** The blank's curated name, e.g. `execution.seller1.signature`. */
    name: string
    page: number
    bbox: [number, number, number, number]
    kind: 'signature' | 'signingDate'
    /** The page's height in points, for whatever origin flip is needed. */
    pageHeight: number
}

/** A document the vendor now holds, with fields placed and roles created. */
export interface PreparedDocument {
    /**
     * The vendor's document id — `SigningEnvelope.externalId`.
     *
     * Validated against `SAFE_SEGMENT` before it is returned, because it
     * becomes an S3 key segment in `keys.auditTrail()` at 3.4. Discovering an
     * unusable id after a contract has been signed is not recoverable.
     */
    externalId: string

    /**
     * Vendor role ids, keyed by our `transactionPartyId`.
     *
     * signNow creates roles implicitly from the `role` name on each placed
     * field and assigns each a 40-character id, which the invite then has to
     * reference. Read back rather than assumed.
     */
    roleIds: Record<string, string>
}

/**
 * What an invite yields.
 *
 * Almost nothing, and that is the vendor's doing: `POST /document/{id}/invite`
 * answers exactly `{"status":"success"}` — no invite id, no signer ids. The
 * per-signer `invite_id` appears only on the webhook events. So there is
 * nothing to correlate with here, and the correlation is built from the events
 * plus `roleIds` instead.
 */
export interface SentInvite {
    invited: { transactionPartyId: string; order: number }[]
}

export interface SignNowProvider {
    readonly name: string

    /**
     * Upload the filled PDF and place the signing fields on it.
     *
     * One call rather than two because the vendor forces them together: fields
     * may only be added while the document is unsent, and `PUT /document/{id}`
     * replaces the entire field set rather than appending. There is no adding a
     * missed signer's field later.
     */
    prepareDocument(input: {
        documentName: string
        pdf: Buffer
        signers: EnvelopeSigner[]
        /** Where each signer signs, keyed by `transactionPartyId`. */
        placements: Record<string, FieldPlacement[]>
    }): Promise<PreparedDocument>

    /**
     * Send the invite, kept separate from `prepareDocument` on purpose.
     *
     * The envelope row is written between the two. If that write fails, what is
     * left behind is an unreferenced vendor document that emailed nobody —
     * rather than signers holding a contract we have no record of.
     */
    inviteSigners(
        externalId: string,
        input: {
            signers: EnvelopeSigner[]
            roleIds: Record<string, string>
            subject: string
            message: string
        }
    ): Promise<SentInvite>

    /**
     * Whether a webhook body really came from signNow.
     *
     * The signature is base64 of the **raw** sha256 HMAC digest — not base64 of
     * the hex string, which is what signNow's own PHP sample
     * (`base64_encode(hex2bin(...))`) reads like at a glance. Verified against
     * real captured callbacks.
     *
     * Takes the raw bytes, never a parsed object: re-serialising JSON produces
     * different bytes and therefore a different digest.
     */
    verifyWebhookSignature(rawBody: Buffer, header: string | undefined): boolean
}

/**
 * Raised when signNow answers, but not with something we can use.
 *
 * The `kind` is what the caller can actually do about it, and the split is not
 * derivable from the HTTP status: signNow answers **400** for a bad API key as
 * well as for a bad request, and returns `code: 1537` for both. Only the
 * `error` string in the body separates them.
 *
 *   misconfigured — the key is wrong, revoked, or the plan lapsed. No retry
 *                   ever helps, so telling an agent to try again is a loop.
 *   unavailable   — the network or the vendor. Trying again might work.
 *   rejected      — signNow understood and refused: a bad address, a document
 *                   with no fields, an invite on an already-sent document.
 *   schema        — it answered with a shape the captured schemas do not
 *                   accept, including an id that would not survive as an S3
 *                   key segment.
 */
export class SignNowError extends Error {
    constructor(
        readonly kind: 'misconfigured' | 'unavailable' | 'rejected' | 'schema',
        message: string,
        readonly status?: number
    ) {
        super(message)
        this.name = 'SignNowError'
    }
}
