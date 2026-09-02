import { Prisma } from '@prisma/client'

import logger from '@/lib/logger'
import prisma from '@/lib/prisma'
import { loadEntryInput } from '@/modules/entries/entries.service'
import { FormTemplateNotSeededError, loadTransactionSnapshot } from '@/modules/forms/fill.service'
import { loadTemplate } from '@/modules/forms/template.service'
import type { AgentProfile } from '@/schemas/agent'
import type {
    ComplianceArea,
    ComplianceFailure,
    ComplianceResult
} from '@/schemas/compliance'
import type { FormTemplate } from '@/schemas/form'
import type { Party, PartyRole } from '@/schemas/party'
import type { TransactionType } from '@/schemas/transaction'
import type { MergedValues, TransactionSnapshot } from '@/modules/forms/mapper.service'
import { buildMergedValues } from '@/modules/forms/mapper.service'

/**
 * The compliance gate (build plan 2.4).
 *
 * One job: decide whether a transaction may be turned into a document that gets
 * signed, and when it may not, say exactly what is wrong in terms an agent can
 * act on. It runs **before** the fill, not after — catching a missing
 * completion date once the parties have signed forces a re-sign loop, which is
 * the thing this product exists to remove.
 *
 * Pure. Same input shape as the field mapper and the same reason: the two have
 * to agree about what a transaction contains, and the cheapest way to guarantee
 * that is for the gate to read the mapper's own output rather than re-deriving
 * it from the database.
 *
 * **There is no override.** A failed check is a hard block: the form is not
 * filled, no partial PDF is produced, and nothing advances to signing. That is
 * a decision, not an omission — see `ComplianceCheck.overrides`, which this
 * writes as an empty list.
 *
 * If an override is ever allowed, the shape here does not have to change. Every
 * failure carries a stable `field`, which is what an override would name; the
 * evaluation is a pure function of its input, so an `overrides` argument would
 * filter the failure list in one place before `passed` is computed from it.
 * Nothing downstream reads anything but `passed` and `failures`.
 */

/** Where each area is fixed, as an agent would name the page. */
const AREA_LABELS: Record<ComplianceArea, string> = {
    profile: 'Agent profile',
    property: 'Property',
    parties: 'Parties',
    entries: 'Agreement terms'
}

/**
 * What an agent calls each blank, and which page fills it.
 *
 * Hand-written rather than taken from the template's `label`, which is the
 * printed text preceding the blank on the page. That text is what makes a
 * *form* readable and not what makes a *checklist* readable: it is empty for
 * every blank on a ruled continuation line, and for the second of a pair it is
 * the first one's label with its own appended — "Seller's Lawyer Buyer's
 * Lawyer". An agent reading a list of what to go and fix needs the name of the
 * thing, not the sentence it sits in.
 *
 * Keyed by the name the gate reports, which for a continuation block is the
 * block rather than its lines. Every reportable Form 100 data blank is here;
 * `describe` falls back to the blank name so a newly curated form is legible
 * before its labels are written rather than crashing or reporting nothing.
 */
const BLANK_LABELS: Record<string, { label: string; area: ComplianceArea }> = {
    'agreement.dateDay': { label: 'Agreement date — day', area: 'entries' },
    'agreement.dateMonth': { label: 'Agreement date — month', area: 'entries' },
    'agreement.dateYear': { label: 'Agreement date — year', area: 'entries' },

    'buyer.fullLegalNames': { label: "Buyer's full legal name", area: 'parties' },
    'seller.fullLegalNames': { label: "Seller's full legal name", area: 'parties' },

    'property.address': { label: 'Property address', area: 'property' },
    'property.frontingSide': { label: 'Fronting on the … side', area: 'property' },
    'property.frontingStreet': { label: 'Fronting street', area: 'property' },
    'property.municipality': { label: 'Municipality', area: 'property' },
    'property.frontage': { label: 'Frontage', area: 'property' },
    'property.depth': { label: 'Depth', area: 'property' },
    'property.legalDescription': { label: 'Legal description', area: 'property' },

    'purchasePrice.numeric': { label: 'Purchase price', area: 'entries' },
    'purchasePrice.words': { label: 'Purchase price in words', area: 'entries' },

    'deposit.timing': { label: 'When the deposit is submitted', area: 'entries' },
    'deposit.amountWords': { label: 'Deposit amount in words', area: 'entries' },
    'deposit.amountNumeric': { label: 'Deposit amount', area: 'entries' },
    'deposit.holder': { label: 'Deposit held in trust by', area: 'entries' },

    'schedules.list': { label: 'Schedules forming part of the agreement', area: 'entries' },

    'irrevocability.boundParty': { label: 'Offer irrevocable by', area: 'entries' },
    'irrevocability.time': { label: 'Irrevocable until (time)', area: 'entries' },
    'irrevocability.dateDay': { label: 'Irrevocable until — day', area: 'entries' },
    'irrevocability.dateMonth': { label: 'Irrevocable until — month', area: 'entries' },
    'irrevocability.dateYear': { label: 'Irrevocable until — year', area: 'entries' },

    'completion.dateDay': { label: 'Completion date — day', area: 'entries' },
    'completion.dateMonth': { label: 'Completion date — month', area: 'entries' },
    'completion.dateYear': { label: 'Completion date — year', area: 'entries' },

    'notices.sellerFax': { label: "Seller's fax for notices", area: 'entries' },
    'notices.buyerFax': { label: "Buyer's fax for notices", area: 'entries' },
    'notices.sellerEmail': { label: "Seller's email for notices", area: 'parties' },
    'notices.buyerEmail': { label: "Buyer's email for notices", area: 'parties' },

    chattelsIncluded: { label: 'Chattels included', area: 'entries' },
    fixturesExcluded: { label: 'Fixtures excluded', area: 'entries' },
    rentalItems: { label: 'Rental items', area: 'entries' },

    'hst.treatment': { label: 'HST included in or in addition to the price', area: 'entries' },

    'titleSearch.dateDay': { label: 'Requisition date — day', area: 'entries' },
    'titleSearch.dateMonth': { label: 'Requisition date — month', area: 'entries' },
    'titleSearch.dateYear': { label: 'Requisition date — year', area: 'entries' },

    'property.presentUse': { label: 'Present use of the property', area: 'entries' },

    'seller.addressForService.line1': { label: "Seller's address for service", area: 'parties' },
    'seller.addressForService.line2': {
        label: "Seller's address for service — city and postal code",
        area: 'parties'
    },
    'seller.addressForService.tel': { label: "Seller's telephone", area: 'parties' },
    'buyer.addressForService.line1': { label: "Buyer's address for service", area: 'parties' },
    'buyer.addressForService.line2': {
        label: "Buyer's address for service — city and postal code",
        area: 'parties'
    },
    'buyer.addressForService.tel': { label: "Buyer's telephone", area: 'parties' },

    'sellerLawyer.name': { label: "Seller's lawyer", area: 'entries' },
    'sellerLawyer.address': { label: "Seller's lawyer — address", area: 'entries' },
    'sellerLawyer.email': { label: "Seller's lawyer — email", area: 'entries' },
    'sellerLawyer.tel': { label: "Seller's lawyer — telephone", area: 'entries' },
    'sellerLawyer.fax': { label: "Seller's lawyer — fax", area: 'entries' },

    'buyerLawyer.name': { label: "Buyer's lawyer", area: 'entries' },
    'buyerLawyer.address': { label: "Buyer's lawyer — address", area: 'entries' },
    'buyerLawyer.email': { label: "Buyer's lawyer — email", area: 'entries' },
    'buyerLawyer.tel': { label: "Buyer's lawyer — telephone", area: 'entries' },
    'buyerLawyer.fax': { label: "Buyer's lawyer — fax", area: 'entries' },

    'scheduleA.buyer.fullLegalNames': { label: "Schedule A — buyer's name", area: 'parties' },
    'scheduleA.seller.fullLegalNames': { label: "Schedule A — seller's name", area: 'parties' },
    'scheduleA.property.line1': { label: 'Schedule A — property address', area: 'property' },
    'scheduleA.property.line2': {
        label: 'Schedule A — property city and postal code',
        area: 'property'
    },
    'scheduleA.dateDay': { label: 'Schedule A date — day', area: 'entries' },
    'scheduleA.dateMonth': { label: 'Schedule A date — month', area: 'entries' },
    'scheduleA.dateYear': { label: 'Schedule A date — year', area: 'entries' }
}

/**
 * The brokerage blanks, which side of the deal each belongs to, and therefore
 * where each is fixed.
 *
 * The agent's own block comes from their profile and the other side's is typed
 * in, so the same blank name is fixed on a different page depending on the
 * transaction type. This follows `brokerageBlock` in the mapper rather than
 * assuming a listing — filling the wrong one puts the seller's agent in the
 * buyer's box, and pointing an agent at the wrong page to fix it is the same
 * mistake one step later.
 */
const BROKERAGE_LABELS: Record<string, string> = {
    name: 'Brokerage name',
    tel: 'Brokerage telephone',
    salesperson: 'Salesperson name'
}

const brokerageFieldLabel = (
    field: string,
    type: TransactionType
): { label: string; area: ComplianceArea } | null => {
    const match = /^(listingBrokerage|coopBrokerage)\.(name|tel|salesperson)$/.exec(field)

    if (!match) {
        return null
    }

    const [, block, part] = match
    const own = type === 'PURCHASE' ? 'coopBrokerage' : 'listingBrokerage'
    const side = block === 'listingBrokerage' ? 'Listing brokerage' : 'Co-operating brokerage'

    return {
        label: `${side} — ${BROKERAGE_LABELS[part].toLowerCase()}`,
        // The agent's own block is their profile; the other side's is typed in
        // with the rest of the agreement.
        area: block === own ? 'profile' : 'entries'
    }
}

/** What to show for a blank, falling back to its name when it has no curated label. */
const describe = (
    field: string,
    type: TransactionType
): { label: string; area: ComplianceArea } =>
    brokerageFieldLabel(field, type) ?? BLANK_LABELS[field] ?? { label: field, area: 'entries' }

const failure = (
    field: string,
    label: string,
    area: ComplianceArea,
    reason: ComplianceFailure['reason']
): ComplianceFailure => ({ field, label, area, areaLabel: AREA_LABELS[area], reason })

/**
 * The blanks the gate is responsible for, in the order the form prints — which
 * is the order an agent works down it.
 *
 * A continuation block appears once, under the name its value arrives as, not
 * once per ruled line. Three empty lines under CHATTELS INCLUDED are not three
 * missing fields; they are one field, and telling an agent to fill in the two
 * spare lines that exist in case the first runs out would be nonsense.
 *
 * Signature and signing-date blanks are absent, and that is the whole reason
 * `kind` exists on a blank. They are filled inside the e-sign session, so
 * counting one as missing would block every transaction that ever existed.
 */
const reportableBlanks = (template: FormTemplate): string[] => {
    const seen = new Set<string>()
    const names: string[] = []

    for (const blank of template.blanks) {
        if (blank.kind !== 'data') {
            continue
        }

        const name = blank.flow ?? blank.name

        if (seen.has(name)) {
            continue
        }

        seen.add(name)
        names.push(name)
    }

    return names
}

/**
 * Has this blank got anything to draw?
 *
 * A continuation block counts as filled if the whole value is there under the
 * block name *or* if any one of its lines has been given a value directly.
 * Both reach the fill engine as a filled block, so both have to read as one
 * here — the gate and the document it gates cannot be allowed to disagree.
 */
const hasValue = (template: FormTemplate, merged: MergedValues, name: string): boolean => {
    if (merged[name] !== undefined) {
        return true
    }

    return template.blanks.some(blank => blank.flow === name && merged[blank.name] !== undefined)
}

/**
 * Every required blank on the form has a value.
 *
 * "Required" is every `data` blank. That is the build plan's own answer — the
 * fill engine's `missing` array *is* the check — and it is not this service's
 * call to decide that an OREA blank is optional. If a fax line may legitimately
 * be left empty, that is a decision about the form, and the place to record it
 * is the curation that names the blanks, not a list of exceptions here.
 */
const missingBlanks = (
    template: FormTemplate,
    merged: MergedValues,
    type: TransactionType,
    excused: Set<string>
): ComplianceFailure[] =>
    reportableBlanks(template)
        .filter(name => !excused.has(name) && !hasValue(template, merged, name))
        .map(name => {
            const { label, area } = describe(name, type)

            return failure(name, label, area, 'missing')
        })

/**
 * The roles a transaction of each type must have somebody in.
 *
 * Form 100 is an Agreement of Purchase and Sale: it names both sides, and one
 * with nobody on one of them is not an incomplete agreement, it is not an
 * agreement. `LEASE` is listed with the same pair because the picker shows it
 * — the flow is not wired (build plan 1.2), and a lease reaching here would be
 * checked rather than waved through.
 */
const REQUIRED_ROLES: Record<TransactionType, PartyRole[]> = {
    LISTING: ['SELLER', 'BUYER'],
    PURCHASE: ['SELLER', 'BUYER'],
    LEASE: ['SELLER', 'BUYER']
}

const ROLE_LABELS: Record<PartyRole, string> = {
    BUYER: 'Buyer',
    SELLER: 'Seller',
    SPOUSE: 'Spouse',
    WITNESS: 'Witness'
}

/**
 * The blanks the mapper fills from one side's parties.
 *
 * Used to keep the report honest when a side is empty: a transaction with no
 * buyer would otherwise be reported as one absent buyer *and* five blanks the
 * agent has no way to fill, because the field they would type into does not
 * exist until the buyer does. One actionable item beats six, five of which
 * resolve themselves.
 */
const blanksFromRole = (role: PartyRole): string[] => {
    const side = role === 'BUYER' ? 'buyer' : 'seller'

    return [
        `${side}.fullLegalNames`,
        `scheduleA.${side}.fullLegalNames`,
        `notices.${side}Email`,
        `${side}.addressForService.line1`,
        `${side}.addressForService.line2`,
        `${side}.addressForService.tel`
    ]
}

/**
 * Somebody is on the transaction in every role its type requires.
 *
 * Returns the failures and the blank names they account for, so the caller can
 * leave those out of the blank check rather than reporting the same problem
 * twice in two vocabularies.
 */
const missingParties = (
    type: TransactionType,
    parties: Party[]
): { failures: ComplianceFailure[]; excused: Set<string> } => {
    const failures: ComplianceFailure[] = []
    const excused = new Set<string>()

    for (const role of REQUIRED_ROLES[type]) {
        if (parties.some(party => party.role === role)) {
            continue
        }

        failures.push(
            failure(
                `party.${role.toLowerCase()}`,
                `No ${ROLE_LABELS[role].toLowerCase()} on this transaction`,
                'parties',
                'absent'
            )
        )

        blanksFromRole(role).forEach(name => excused.add(name))
    }

    return { failures, excused }
}

/**
 * The agent's own details, and their brokerage's.
 *
 * Checked as profile fields rather than only as form blanks because the RECO
 * registration number is neither — it does not appear on Form 100 and it is
 * still not optional for a registrant in Ontario. The brokerage's address is
 * the same: no blank on this form carries it, and a brokerage record without
 * one is not a brokerage record.
 *
 * The telephone is checked once, against either number. The mapper prints the
 * brokerage's line and falls back to the agent's, so an agent with a direct
 * line and a brokerage preset that has none is complete, not incomplete.
 */
const incompleteProfile = (agent: AgentProfile | null | undefined): ComplianceFailure[] => {
    const failures: ComplianceFailure[] = []

    const require = (field: string, label: string, value: string | null | undefined) => {
        if (value === null || value === undefined || value.trim() === '') {
            failures.push(failure(field, label, 'profile', 'missing'))
        }
    }

    if (!agent) {
        // Unreachable through the routes — everything under /api is behind the
        // session guard, which loads the agent. Not an assumption worth making
        // in a function that decides whether a contract may be signed.
        return [failure('agent', 'Agent profile', 'profile', 'absent')]
    }

    require('agent.name', 'Your name', agent.name)
    require('agent.recoNumber', 'Your RECO registration number', agent.recoNumber)

    if (!agent.brokerage) {
        failures.push(failure('agent.brokerage', 'Your brokerage', 'profile', 'absent'))

        return failures
    }

    require('brokerage.name', 'Brokerage name', agent.brokerage.name)
    require('brokerage.address', 'Brokerage address', agent.brokerage.address)

    if (!agent.brokerage.phone?.trim() && !agent.phone?.trim()) {
        failures.push(
            failure(
                'brokerage.phone',
                'A telephone number — your brokerage’s or your own',
                'profile',
                'missing'
            )
        )
    }

    return failures
}

/**
 * Run the gate against one transaction and one form.
 *
 * Pure: a snapshot and a template in, a verdict out. No database, no S3, no
 * clock beyond the timestamp on the result — which is the point. The gate
 * decides whether a document may exist, and a decision like that should be
 * reproducible from its inputs and testable without any of them being real.
 *
 * Order matters in the output and not in the checking: the profile first
 * because an incomplete profile is wrong on every transaction the agent has,
 * then the parties, then the form's own blanks in the order it prints them.
 */
export const evaluateCompliance = (
    template: FormTemplate,
    snapshot: TransactionSnapshot,
    now: Date = new Date()
): ComplianceResult => {
    const type = snapshot.transaction.type
    const merged = buildMergedValues(snapshot)

    const parties = missingParties(type, snapshot.parties ?? [])

    const failures = [
        ...incompleteProfile(snapshot.agent),
        ...parties.failures,
        ...missingBlanks(template, merged, type, parties.excused)
    ]

    return {
        formCode: template.form,
        // No override, by decision: `passed` is the absence of failures and
        // nothing else can set it.
        passed: failures.length === 0,
        failures,
        checkedAt: now.toISOString()
    }
}


// ---------------------------------------------------------------------------
// Recording a check
// ---------------------------------------------------------------------------
//
// Everything above this line is pure. Everything below it reads and writes the
// database, and does no deciding: what passes is settled by `evaluateCompliance`
// and this only remembers what it said.

/**
 * Run the gate for one transaction and one form, and record the result.
 *
 * The check is recorded whether it passed or failed. A failed gate is the more
 * interesting of the two — it is the record of why a document was not produced
 * on a particular afternoon, which is exactly what someone asks about later.
 *
 * `ComplianceCheck` hangs off `TransactionForm`, so the row is created here if
 * this is the first time the form has been touched. It is created `DRAFT` with
 * the merged values and no `filledS3Key`: nothing has been drawn, and the fill
 * engine is what moves it to `FILLED`.
 *
 * `overrides` is written as an empty list on every check. The column exists
 * because build plan 0.2 put it there; the policy is that there is no override,
 * so nothing ever writes to it. Left in place rather than dropped — a migration
 * removing a column that a future decision would have to add back is churn, and
 * an empty list is an honest record of "nothing was waived here".
 */
export const runComplianceGate = async (
    transactionId: string,
    agentId: string,
    formCode: string
): Promise<ComplianceResult> => {
    const { template, snapshot, result } = await checkTransaction(transactionId, agentId, formCode)

    await recordComplianceCheck(transactionId, template, snapshot, result)

    return result
}

/**
 * The same verdict, without recording it.
 *
 * What the overview page reads to show each section as complete or not. That is
 * a page an agent opens and reopens while working, and a `ComplianceCheck` row
 * per glance would turn the record of "why was this blocked on Tuesday" into
 * noise. A check is worth remembering when something was gated on it, which is
 * the POST.
 */
export const checkCompliance = async (
    transactionId: string,
    agentId: string,
    formCode: string
): Promise<ComplianceResult> =>
    (await checkTransaction(transactionId, agentId, formCode)).result

/** Load everything the gate reads, and evaluate. No writes. */
const checkTransaction = async (transactionId: string, agentId: string, formCode: string) => {
    const template = await loadTemplate(formCode)

    const entries = await loadEntryInput(transactionId, agentId)
    const snapshot = await loadTransactionSnapshot(transactionId, agentId, entries)

    return { template, snapshot, result: evaluateCompliance(template, snapshot) }
}

/**
 * Persist one check against the transaction's row for this form.
 *
 * The merged object is stored beside it, so a check can be read back later
 * against what it was actually looking at rather than against whatever the
 * transaction has become since.
 */
const recordComplianceCheck = async (
    transactionId: string,
    template: FormTemplate,
    snapshot: TransactionSnapshot,
    result: ComplianceResult
): Promise<void> => {
    const formTemplate = await prisma.formTemplate.findUnique({
        where: { formCode_revision: { formCode: template.form, revision: template.revision } },
        select: { id: true }
    })

    if (!formTemplate) {
        throw new FormTemplateNotSeededError(template.form, template.revision)
    }

    // Keys with nothing behind them are dropped rather than stored as JSON
    // nulls, matching `fillTransactionForm` — `values` is the record of what
    // this check had, and a key present with no value reads as one that was
    // cleared.
    const values = Object.fromEntries(
        Object.entries(buildMergedValues(snapshot)).filter(([, value]) => value !== undefined)
    ) as Prisma.InputJsonObject

    // No unique constraint on (transactionId, formTemplateId) to upsert
    // against, the same as in the fill engine. One row per form per
    // transaction, found and updated rather than accumulated.
    const existing = await prisma.transactionForm.findFirst({
        where: { transactionId, formTemplateId: formTemplate.id },
        select: { id: true }
    })

    const formId = existing
        ? (
              await prisma.transactionForm.update({
                  where: { id: existing.id },
                  data: { values },
                  select: { id: true }
              })
          ).id
        : (
              await prisma.transactionForm.create({
                  data: { transactionId, formTemplateId: formTemplate.id, values },
                  select: { id: true }
              })
          ).id

    await prisma.complianceCheck.create({
        data: {
            transactionFormId: formId,
            missingFields: result.failures as unknown as Prisma.InputJsonArray,
            // Always empty. There is no override path — see the note at the top
            // of this module.
            overrides: [] as Prisma.InputJsonArray,
            passed: result.passed,
            checkedAt: new Date(result.checkedAt)
        }
    })

    logger.info('compliance check recorded', {
        transactionId,
        formCode: template.form,
        passed: result.passed,
        failures: result.failures.length
    })
}
