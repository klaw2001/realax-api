/**
 * A signNow provider that talks to nobody.
 *
 * No network, no key, no invite quota, no email to a real address. It exists
 * for the same reason `ocr/mock.client.ts` does: signNow API access is a
 * separate annual commitment and the trial lapses, so the signing flow has to
 * be demonstrable and testable without one.
 *
 * What it does **not** fake is the HMAC. `verifyWebhookSignature` is the real
 * implementation, so the webhook tests exercise production crypto against
 * production code — the mock removes the network, not the security.
 */

import { createHash } from 'crypto'

import { verifyWebhookSignature } from '@/integrations/signnow/signnow.client'
import {
    SignNowError,
    type EnvelopeSigner,
    type FieldPlacement,
    type PreparedDocument,
    type SentInvite,
    type SignNowProvider
} from '@/integrations/signnow/provider'

/**
 * A forced failure, for tests that need one.
 *
 * Tests only — nothing in production sets this.
 */
let outcome: SignNowError['kind'] | null = null

export const __setMockOutcome = (kind: SignNowError['kind'] | null): void => {
    outcome = kind
}

const failIfAsked = (what: string): void => {
    if (outcome !== null) {
        throw new SignNowError(outcome, `Mock signNow ${what} failed on purpose (${outcome})`)
    }
}

/**
 * A document id derived from the PDF's own bytes.
 *
 * Deterministic — the same filled form always produces the same id, so a test
 * can assert an envelope was reused rather than re-uploaded. Forty lowercase
 * hex characters, matching the real vendor's ids, which means it also satisfies
 * `SAFE_SEGMENT` and will survive being used as an S3 key segment at 3.4.
 */
const mockDocumentId = (pdf: Buffer): string => createHash('sha256').update(pdf).digest('hex').slice(0, 40)

const prepareDocument = async (input: {
    documentName: string
    pdf: Buffer
    signers: EnvelopeSigner[]
    placements: Record<string, FieldPlacement[]>
}): Promise<PreparedDocument> => {
    failIfAsked('prepareDocument')

    const externalId = mockDocumentId(input.pdf)

    // The real vendor creates one role per distinct role name and would refuse
    // an invite naming a role that does not exist. Mirrored so a signer whose
    // fields were never placed fails here too, rather than only in production.
    const roleIds: Record<string, string> = {}

    for (const signer of input.signers) {
        if ((input.placements[signer.transactionPartyId] ?? []).length === 0) {
            throw new SignNowError('rejected', 'No signing fields were placed for a signer')
        }

        roleIds[signer.transactionPartyId] = createHash('sha256')
            .update(`${externalId}:${signer.role}`)
            .digest('hex')
            .slice(0, 40)
    }

    return { externalId, roleIds }
}

const inviteSigners = async (
    externalId: string,
    input: { signers: EnvelopeSigner[]; roleIds: Record<string, string> }
): Promise<SentInvite> => {
    failIfAsked('inviteSigners')

    for (const signer of input.signers) {
        if (input.roleIds[signer.transactionPartyId] === undefined) {
            throw new SignNowError('rejected', 'A signer has no role on the document')
        }
    }

    return {
        invited: input.signers.map(signer => ({
            transactionPartyId: signer.transactionPartyId,
            order: signer.order
        }))
    }
}

export const mockProvider: SignNowProvider = {
    name: 'mock',
    prepareDocument,
    inviteSigners,
    // Deliberately the real one.
    verifyWebhookSignature
}
