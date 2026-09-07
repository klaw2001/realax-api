import type { AgentProfile } from '@/schemas/agent'
import type { FormTemplate } from '@/schemas/form'
import type { Party, PartyRole } from '@/schemas/party'
import type { Property } from '@/schemas/property'
import type { TransactionType } from '@/schemas/transaction'

/**
 * The field mapper (build plan 2.2).
 *
 * One job: turn a transaction — its property, its parties, the agent's profile,
 * and whatever the agent typed that no column exists for — into a single flat
 * object keyed by the names the curated templates give their blanks. It is the
 * only place that knows a `Property.city` is what goes in "in the ___" on
 * Form 100.
 *
 * Two consumers, one object. The fill engine (2.3) draws it and the compliance
 * gate (2.4) counts what is missing from it, so a value they disagree about is
 * impossible by construction rather than by being kept in step.
 *
 * The domain model does not carry most of an Agreement of Purchase and Sale —
 * there is no purchase price column, no completion date, no chattels list. That
 * is deliberate: those are captured as `entries`, a generic object of dot-pathed
 * or nested values that is overlaid on top of the domain layer. Manual entry
 * feeds it today and the OCR work in 2.5 feeds the same object later, so neither
 * needs this module rewritten to arrive.
 */

/**
 * A merged object: blank name → the text to draw.
 *
 * `undefined` is a value here, not an absence — "this blank has nothing for it"
 * is what the compliance gate reads. Everything is a string because a form is
 * print output; numbers are formatted on the way in, once, where the formatting
 * rule is known.
 */
export type MergedValues = Record<string, string | undefined>

/** Anything the caller hands over as entries, before it is flattened. */
export type EntryInput = Record<string, unknown>

/**
 * What the mapper is given. Every part is optional but `transaction`: a draft
 * with no property and no parties is a normal state, and the mapper's answer for
 * it is a merged object of `undefined`s rather than an error.
 */
export interface TransactionSnapshot {
    transaction: { type: TransactionType }
    agent?: AgentProfile | null
    property?: Property | null
    parties?: Party[]

    /**
     * Values the domain model has no column for, and corrections to the ones it
     * has. Keys may be dot-pathed (`'hst.treatment'`), nested
     * (`{ hst: { treatment } }`), or a mix; both flatten to the same thing.
     */
    entries?: EntryInput
}

const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
]

/**
 * A value as it will be printed, or `undefined` when there is nothing to print.
 *
 * Blank and whitespace-only strings collapse to `undefined` so that a cleared
 * field reads as missing to the compliance gate rather than as a satisfied blank
 * containing a space. Types that have no unambiguous printed form — booleans,
 * dates, objects — are dropped rather than guessed at: a form saying "true" is
 * worse than a form with a gap in it.
 */
const toText = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
        const trimmed = value.trim()

        return trimmed === '' ? undefined : trimmed
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value)
    }

    return undefined
}

/** Joined with single spaces, blanks dropped. `undefined` if nothing is left. */
const join = (...parts: (string | null | undefined)[]): string | undefined =>
    toText(parts.map(part => part ?? '').join(' '))

/**
 * Names on one line, the way an agent writes them: "A", "A and B",
 * "A, B and C".
 */
const joinNames = (names: string[]): string | undefined => {
    const kept = names.map(name => name.trim()).filter(name => name !== '')

    if (kept.length === 0) {
        return undefined
    }

    if (kept.length === 1) {
        return kept[0]
    }

    return `${kept.slice(0, -1).join(', ')} and ${kept[kept.length - 1]}`
}

/**
 * An amount as OREA prints it: grouped, two decimals, no currency symbol — the
 * form already prints "(CDN$)" beside the blank.
 *
 * A non-numeric string passes through as written. Deposit terms are occasionally
 * a phrase rather than a figure, and rewriting one into `NaN` would be worse
 * than printing what the agent typed.
 */
const toAmount = (value: unknown): string | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value.toLocaleString('en-CA', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        })
    }

    const text = toText(value)

    if (text === undefined) {
        return undefined
    }

    // Digits, separators and a decimal point only — "1,250,000" is a figure,
    // "on acceptance" is not.
    if (!/^[0-9][0-9,\s]*(\.[0-9]+)?$/.test(text)) {
        return text
    }

    const amount = Number(text.replace(/[,\s]/g, ''))

    return Number.isFinite(amount) ? toAmount(amount) : text
}

/**
 * A date split the way the forms print one: "dated this ___ day of ___, 20 ___".
 *
 * The year is two digits because the century is preprinted on every one of these
 * lines. The day is plain digits rather than an ordinal — "2" and "2nd" are both
 * accepted on a signed agreement, and inventing the suffix is a formatting
 * opinion this module has no reason to hold.
 *
 * Takes `YYYY-MM-DD` or a full ISO instant, and reads it in UTC: these are
 * calendar dates, and parsing one in a local timezone moves it by a day for
 * anyone west of Greenwich.
 */
export const splitFormDate = (
    value: unknown
): { day: string; month: string; year: string } | undefined => {
    const text = toText(value)

    if (text === undefined) {
        return undefined
    }

    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)

    if (!match) {
        return undefined
    }

    const [, year, month, day] = match
    const monthIndex = Number(month) - 1

    if (monthIndex < 0 || monthIndex > 11 || Number(day) < 1 || Number(day) > 31) {
        return undefined
    }

    return {
        day: String(Number(day)),
        month: MONTHS[monthIndex],
        year: year.slice(2)
    }
}

const isPlainObject = (value: unknown): value is EntryInput =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A nested entry object flattened to dot paths.
 *
 * An array becomes the `lineN` keys the templates use for the multi-line blocks
 * — chattels, fixtures, rentals — because those are separate named blanks on the
 * form rather than one box. Wrapping a long single line across them is the fill
 * engine's business in 2.3: it has the font metrics, and this module does not.
 */
const flattenEntries = (input: EntryInput, prefix = ''): MergedValues => {
    const flat: MergedValues = {}

    for (const [key, value] of Object.entries(input)) {
        const path = prefix === '' ? key : `${prefix}.${key}`

        if (isPlainObject(value)) {
            Object.assign(flat, flattenEntries(value, path))
            continue
        }

        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                flat[`${path}.line${index + 1}`] = toText(item)
            })
            continue
        }

        flat[path] = toText(value)
    }

    return flat
}

/**
 * The derived keys an entry implies.
 *
 * Two rules, both of which exist because the form splits one thing an agent
 * knows into several blanks:
 *
 * - any `X.date` fans out into `X.dateDay`, `X.dateMonth`, `X.dateYear`;
 * - the money blanks are formatted from the plain figure.
 *
 * Schedule A carries the agreement's own date, so it follows `agreement.date`
 * unless it was given one of its own. That is a domain fact — one agreement, one
 * date — not a convenience.
 *
 * Derived keys never overwrite an explicit one: an agent who typed a year into
 * `agreement.dateYear` gets that year.
 */
const derivedEntries = (flat: MergedValues): MergedValues => {
    const derived: MergedValues = {}

    const dateKeys = Object.keys(flat).filter(key => key.endsWith('.date') || key === 'date')

    for (const key of dateKeys) {
        const parts = splitFormDate(flat[key])

        if (!parts) {
            continue
        }

        const prefix = key === 'date' ? '' : `${key.slice(0, -'.date'.length)}.`
        derived[`${prefix}dateDay`] = parts.day
        derived[`${prefix}dateMonth`] = parts.month
        derived[`${prefix}dateYear`] = parts.year
    }

    const agreementDate = splitFormDate(flat['agreement.date'])
    if (agreementDate && flat['scheduleA.date'] === undefined) {
        derived['scheduleA.dateDay'] = agreementDate.day
        derived['scheduleA.dateMonth'] = agreementDate.month
        derived['scheduleA.dateYear'] = agreementDate.year
    }

    derived['purchasePrice.numeric'] = toAmount(flat['purchasePrice'])
    derived['deposit.amountNumeric'] = toAmount(flat['deposit.amount'])

    return derived
}

/** Live parties in a role, in signing order, with unordered ones last. */
const inRole = (parties: Party[], role: PartyRole): Party[] =>
    parties
        .filter(party => party.role === role)
        .sort((a, b) => (a.signingOrder ?? Number.MAX_SAFE_INTEGER) - (b.signingOrder ?? Number.MAX_SAFE_INTEGER))

/**
 * The address-for-service block for one side: street on the first line, the
 * rest of the address on the second, phone on the third.
 *
 * Taken from the first party on that side. The blank is one address per side on
 * the form, and the first signer is whose it is.
 */
const addressForService = (party: Party | undefined, prefix: string): MergedValues => ({
    [`${prefix}.addressForService.line1`]: toText(party?.address),
    [`${prefix}.addressForService.line2`]: join(party?.city, party?.province, party?.postalCode),
    [`${prefix}.addressForService.tel`]: toText(party?.phone),

    // The same address taken apart. Form 371 prints the municipality and the
    // postal code on their own captioned lines rather than as one block, so
    // they are served as their own keys instead of the form having to unpick
    // the joined second line.
    [`${prefix}.municipality`]: toText(party?.city),
    [`${prefix}.postalCode`]: toText(party?.postalCode)
})

/**
 * Which brokerage block the signed-in agent's own details belong in.
 *
 * On a listing the agent is the listing brokerage; on a purchase they are the
 * co-operating brokerage acting for the buyer. Filling the wrong one puts the
 * seller's agent in the buyer's box on a document that goes to both lawyers, so
 * this follows the transaction type rather than defaulting.
 *
 * A lease is handled as a listing: the agent taking the deal is on the landlord's
 * side, the same way. Form 100 is not the lease form — see NEEDS-KLAW for which
 * OREA lease form this is checked against when leases are wired.
 *
 * Exported because the compliance gate needs the same answer to decide which
 * page to send an agent to for a missing brokerage blank. It used to hold its
 * own copy of the rule; two copies of a decision this consequential is one
 * edit away from the gate and the fill engine disagreeing about which side of
 * a deal the agent is on.
 */
export const brokerageBlock = (type: TransactionType): 'listingBrokerage' | 'coopBrokerage' =>
    type === 'PURCHASE' ? 'coopBrokerage' : 'listingBrokerage'

/**
 * The layer the domain model can answer for. Everything absent from it is a
 * blank no column exists for — those arrive as entries.
 */
const domainValues = (snapshot: TransactionSnapshot): MergedValues => {
    const { transaction, agent, property, parties = [] } = snapshot

    const buyers = inRole(parties, 'BUYER')
    const sellers = inRole(parties, 'SELLER')
    const buyerNames = joinNames(buyers.map(party => party.fullLegalName))
    const sellerNames = joinNames(sellers.map(party => party.fullLegalName))
    const brokerage = brokerageBlock(transaction.type)

    return {
        'buyer.fullLegalNames': buyerNames,
        'seller.fullLegalNames': sellerNames,

        'property.address': toText(property?.address),

        // "in the ___" — the municipality the property sits in, which is the
        // city as MLS and the property form both carry it.
        'property.municipality': toText(property?.city),
        'property.frontingSide': toText(property?.frontingSide),
        'property.frontingStreet': toText(property?.frontingStreet),
        'property.frontage': toText(property?.frontage),
        'property.depth': toText(property?.depth),
        'property.legalDescription': toText(property?.legalDescription),

        // The notice blanks are how the other side is served under the
        // agreement, so they are the parties' own contact details, not the
        // brokerages'.
        'notices.buyerEmail': toText(buyers[0]?.email),
        'notices.sellerEmail': toText(sellers[0]?.email),

        ...addressForService(buyers[0], 'buyer'),
        ...addressForService(sellers[0], 'seller'),

        [`${brokerage}.name`]: toText(agent?.brokerage?.name),

        // The brokerage's line, falling back to the agent's own. An agent
        // without a brokerage preset selected still has a number to be reached
        // on, and a blank telephone on a signed agreement is a real problem.
        [`${brokerage}.tel`]: toText(agent?.brokerage?.phone) ?? toText(agent?.phone),
        [`${brokerage}.salesperson`]: toText(agent?.name),

        // Form 320 prints the brokerage's address too. One line, because that
        // is how a `Brokerage` stores it — the form's second line is there for
        // an address that does not fit, and is typed when it is needed.
        [`${brokerage}.address.line1`]: toText(agent?.brokerage?.address),

        // Schedule A repeats the front page. Same values, because they are the
        // same deal — a schedule naming different parties than the agreement it
        // is attached to is a defect.
        // Form 371's execution block gives the second buyer their own telephone
        // line, which no other form does. The first buyer's is the address-for-
        // service number above.
        'buyer2.tel': toText(buyers[1]?.phone),

        // Form 371. The designated representative is the individual who
        // represents the buyer under TRESA, and it is the signed-in agent
        // unless the brokerage has designated somebody else — which the entries
        // column overrides this with.
        designatedRepresentatives: toText(agent?.name),

        // The declaration of insurance names the salesperson again, a few lines
        // under their own signature. Same person, so the same value; a separate
        // key only because a curated blank name is used once per form.
        'insuranceDeclaration.salesperson': toText(agent?.name),

        'scheduleA.buyer.fullLegalNames': buyerNames,
        'scheduleA.seller.fullLegalNames': sellerNames,
        'scheduleA.property.line1': toText(property?.address),
        'scheduleA.property.line2': join(property?.city, property?.province, property?.postalCode),

        // Form 371's Schedule A repeats the brokerage rather than the property.
        [`scheduleA.${brokerage}.name`]: toText(agent?.brokerage?.name)
    }
}

/**
 * The merged object for a transaction.
 *
 * Three layers, later winning: what the domain model knows, what the entries
 * imply, then the entries themselves. Entries win over the domain layer because
 * an agent who typed a value into a form was looking at the deal — if the seller
 * serves notice at an address other than the one on their licence, the typed one
 * is the correct one.
 *
 * Keys with nothing behind them are present and `undefined` rather than absent,
 * so a consumer reading a blank name always gets an answer.
 */
export const buildMergedValues = (snapshot: TransactionSnapshot): MergedValues => {
    const entries = flattenEntries(snapshot.entries ?? {})

    return {
        ...domainValues(snapshot),
        ...prune(derivedEntries(entries)),
        ...prune(entries)
    }
}

/**
 * Drop the keys with no value, so an overlay layer cannot blank out a value the
 * layer beneath it filled. An entry that is genuinely being cleared is cleared
 * where it is stored, not by writing `undefined` over the domain.
 */
const prune = (values: MergedValues): MergedValues => {
    const kept: MergedValues = {}

    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) {
            kept[key] = value
        }
    }

    return kept
}

/**
 * The merged object projected onto one template: every blank the form names,
 * whether or not there is anything for it.
 *
 * Signature and signing-date blanks are always `undefined`, even when the merged
 * object carries something for them. They are filled inside the e-sign session
 * (3.2), and a signature drawn into a PDF before anyone signed it is a forged
 * document — so this refuses to hand one to the fill engine rather than trusting
 * that nothing upstream ever puts one there.
 *
 * Keys the merged object holds that the form does not name are dropped: a
 * template asks for what it needs, and a Form 320 value has no business
 * appearing on Form 100.
 */
export const mapTemplateValues = (
    template: FormTemplate,
    merged: MergedValues
): MergedValues => {
    const values: MergedValues = {}

    for (const blank of template.blanks) {
        values[blank.name] = blank.kind === 'data' ? merged[blank.name] : undefined
    }

    return values
}

/**
 * The one call the fill engine and the compliance gate make: a transaction and a
 * template in, the values for that form out.
 */
export const mapTransactionToTemplate = (
    template: FormTemplate,
    snapshot: TransactionSnapshot
): MergedValues => mapTemplateValues(template, buildMergedValues(snapshot))
