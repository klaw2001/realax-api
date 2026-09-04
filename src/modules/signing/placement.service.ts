import { type FieldPlacement } from '@/integrations/signnow/provider'
import type { FormTemplate } from '@/schemas/form'
import type { Party } from '@/schemas/party'

/**
 * Which blanks on the form belong to which party (build plan 3.1).
 *
 * The curated templates name execution blanks positionally —
 * `execution.buyer1.signature`, `execution.seller2.date` — because that is how
 * the printed form is laid out: two buyer lines, two seller lines, one spousal
 * consent line. So placing signature fields means deciding which party is
 * "buyer1", and that decision has to match the one the field mapper already
 * made when it filled the names in.
 *
 * `mapper.service.ts` fills `buyers[0]` into the first buyer slot, and the
 * party list arrives ordered `signingOrder asc nulls last, createdAt asc`. This
 * file follows the same order for the same reason: the person whose printed
 * name is on a line must be the person whose signature box is on it.
 */

/**
 * The blank-name prefix for a party, or null when the form has no line for it.
 *
 * The OREA Form 100 has exactly two buyer lines and two seller lines. A third
 * buyer is a real situation and the form has nowhere to put them — which is a
 * limitation of the paper, not a bug here, and it has to be reported rather
 * than silently dropping a signer from a contract.
 */
const prefixFor = (party: Party, indexWithinRole: number): string | null => {
    switch (party.role) {
        case 'BUYER':
            return indexWithinRole < 2 ? `execution.buyer${indexWithinRole + 1}` : null
        case 'SELLER':
            return indexWithinRole < 2 ? `execution.seller${indexWithinRole + 1}` : null
        case 'SPOUSE':
            // One spousal consent line, and it is a different clause on the
            // form rather than another execution line.
            return indexWithinRole < 1 ? 'spousalConsent' : null
        case 'WITNESS':
            // Witness blanks exist but belong to the *other* party's execution
            // block — `execution.buyer1.witness` is witnessed by whoever is
            // standing there, not by a party we invite. Deliberately unplaced:
            // inviting a witness to sign their own line would put them in the
            // signing sequence for a box that is not theirs.
            return null
    }
}

export class SignerHasNoLineError extends Error {
    constructor(readonly transactionPartyId: string, readonly role: Party['role']) {
        super(`The form has no signing line for an additional ${role.toLowerCase()}`)
        this.name = 'SignerHasNoLineError'
    }
}

/**
 * Where each party signs, keyed by `transactionPartyId`.
 *
 * Only `signature` and `signingDate` blanks are placed. `data` blanks are the
 * agent's and were drawn into the PDF by the fill engine before this point —
 * putting a signNow field over one would invite the signer to overwrite a
 * value the compliance gate has already checked.
 *
 * `.witness` blanks are skipped even under a party's own prefix: the witness
 * line in a buyer's execution block is signed by a witness present at signing,
 * not by the buyer.
 */
export const placementsForParties = (
    template: FormTemplate,
    parties: Party[]
): Record<string, FieldPlacement[]> => {
    const pageHeight = new Map(template.pages.map(page => [page.page, page.height]))
    const seenPerRole = new Map<Party['role'], number>()
    const placements: Record<string, FieldPlacement[]> = {}

    for (const party of parties) {
        const index = seenPerRole.get(party.role) ?? 0
        seenPerRole.set(party.role, index + 1)

        const prefix = prefixFor(party, index)

        if (prefix === null) {
            throw new SignerHasNoLineError(party.id, party.role)
        }

        const blanks = template.blanks.filter(
            blank =>
                blank.name.startsWith(`${prefix}.`) &&
                (blank.kind === 'signature' || blank.kind === 'signingDate') &&
                !blank.name.endsWith('.witness')
        )

        if (blanks.length === 0) {
            throw new SignerHasNoLineError(party.id, party.role)
        }

        placements[party.id] = blanks.map(blank => ({
            name: blank.name,
            page: blank.page,
            bbox: blank.bbox as [number, number, number, number],
            kind: blank.kind === 'signature' ? 'signature' : 'signingDate',
            // Per page rather than assumed: a form is not obliged to be Letter
            // throughout, and the y flip is measured against the page the field
            // is actually on.
            pageHeight: pageHeight.get(blank.page) ?? 792
        }))
    }

    return placements
}
