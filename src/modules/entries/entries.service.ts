import { Prisma } from '@prisma/client'

import prisma from '@/lib/prisma'
import type { EntryInput } from '@/modules/forms/mapper.service'
import { TransactionNotFoundError } from '@/modules/transaction/transaction.service'
import type { SaveTransactionEntriesRequest, TransactionEntries } from '@/schemas/entries'

/**
 * Entries — the agreement terms (build plan 2.3).
 *
 * One row per transaction, holding the 52 Form 100 data blanks the domain model
 * has no column for. Two consumers: the agent's form, through the endpoints in
 * this module, and the field mapper, through `toEntryInput` below.
 *
 * Every function takes an `agentId` and filters on it inside the query rather
 * than checking ownership after reading — the same rule the property and party
 * services follow, for the same reason.
 */

// Re-exported, not redeclared. A second class with this name would be a second
// type, and a controller catching the other one would answer 500 to a request
// this module correctly refused.
export { TransactionNotFoundError }

const entriesSelect = {
    transactionId: true,
    agreementDate: true,
    purchasePrice: true,
    purchasePriceWords: true,
    depositTiming: true,
    depositAmount: true,
    depositAmountWords: true,
    depositHolder: true,
    schedulesList: true,
    irrevocabilityBoundParty: true,
    irrevocabilityTime: true,
    irrevocabilityDate: true,
    completionDate: true,
    titleSearchDate: true,
    noticesSellerFax: true,
    noticesBuyerFax: true,
    chattelsIncluded: true,
    fixturesExcluded: true,
    rentalItems: true,
    hstTreatment: true,
    propertyPresentUse: true,
    listingBrokerageName: true,
    listingBrokerageTel: true,
    listingBrokerageSalesperson: true,
    coopBrokerageName: true,
    coopBrokerageTel: true,
    coopBrokerageSalesperson: true,
    coopBrokerageAddress: true,
    coopBrokerageAddress2: true,
    coopBrokerageFax: true,
    listingBrokerageAddress: true,
    listingBrokerageAddress2: true,
    listingBrokerageFax: true,
    coopCommissionAmount: true,
    coopCommissionTerms: true,
    sellerBrokerageCommentsSingle: true,
    sellerBrokerageCommentsMultiple: true,
    coopBrokerageComments: true,
    offerSubmittedHow: true,
    offerSubmittedTime: true,
    offerSubmittedDate: true,
    counterOfferBuyerNames: true,
    counterOfferSubmittedHow: true,
    counterOfferSubmittedTime: true,
    counterOfferSubmittedDate: true,
    counterOfferIrrevocableTime: true,
    counterOfferIrrevocableDate: true,
    sellerContact: true,
    offerReceivedHow: true,
    offerReceivedTime: true,
    offerReceivedDate: true,
    offerPresentedHow: true,
    offerPresentedTime: true,
    offerPresentedDate: true,
    offerComments: true,

    designatedRepresentatives: true,
    commencementTime: true,
    commencementDate: true,
    expiryDate: true,
    buyerRequirementsPropertyType: true,
    buyerRequirementsGeographicLocation: true,
    additionalSchedulesList: true,
    commissionPercent: true,
    commissionAlternative: true,
    commissionLease: true,
    holdoverPeriodDays: true,
    sellerLawyerName: true,
    sellerLawyerAddress: true,
    sellerLawyerEmail: true,
    sellerLawyerTel: true,
    sellerLawyerFax: true,
    buyerLawyerName: true,
    buyerLawyerAddress: true,
    buyerLawyerEmail: true,
    buyerLawyerTel: true,
    buyerLawyerFax: true,
    updatedAt: true
} as const

type EntriesRecord = Prisma.TransactionEntriesGetPayload<{ select: typeof entriesSelect }>

/**
 * A Postgres `DATE` back as `YYYY-MM-DD`.
 *
 * Prisma hands these back as a Date at UTC midnight, so the ISO string's date
 * half is the date that was stored. Formatting in local time would move a
 * completion date by a day for anyone west of Greenwich.
 */
const toDateOnly = (value: Date | null) => (value === null ? null : value.toISOString().slice(0, 10))

/** `YYYY-MM-DD` as the instant Prisma stores in a `DATE` column. */
const fromDateOnly = (value: string | null | undefined) =>
    value === null || value === undefined ? null : new Date(`${value}T00:00:00.000Z`)

/**
 * A `DECIMAL(12, 2)` back as a plain decimal string.
 *
 * `toFixed(2)` rather than `toString()` so `1225000` and `1225000.00` are the
 * same value over the wire — the column is scaled to two places and the
 * contract says so.
 */
const toAmount = (value: Prisma.Decimal | null) => (value === null ? null : value.toFixed(2))

/** Prisma row → the shape published in `openapi.json`. */
const toEntries = (record: EntriesRecord): TransactionEntries => ({
    transactionId: record.transactionId,
    agreementDate: toDateOnly(record.agreementDate),
    purchasePrice: toAmount(record.purchasePrice),
    purchasePriceWords: record.purchasePriceWords,
    depositTiming: record.depositTiming,
    depositAmount: toAmount(record.depositAmount),
    depositAmountWords: record.depositAmountWords,
    depositHolder: record.depositHolder,
    schedulesList: record.schedulesList,
    irrevocabilityBoundParty: record.irrevocabilityBoundParty,
    irrevocabilityTime: record.irrevocabilityTime,
    irrevocabilityDate: toDateOnly(record.irrevocabilityDate),
    completionDate: toDateOnly(record.completionDate),
    titleSearchDate: toDateOnly(record.titleSearchDate),
    noticesSellerFax: record.noticesSellerFax,
    noticesBuyerFax: record.noticesBuyerFax,
    chattelsIncluded: record.chattelsIncluded,
    fixturesExcluded: record.fixturesExcluded,
    rentalItems: record.rentalItems,
    hstTreatment: record.hstTreatment,
    propertyPresentUse: record.propertyPresentUse,
    listingBrokerageName: record.listingBrokerageName,
    listingBrokerageTel: record.listingBrokerageTel,
    listingBrokerageSalesperson: record.listingBrokerageSalesperson,
    coopBrokerageName: record.coopBrokerageName,
    coopBrokerageTel: record.coopBrokerageTel,
    coopBrokerageSalesperson: record.coopBrokerageSalesperson,
    coopBrokerageAddress: record.coopBrokerageAddress,
    coopBrokerageAddress2: record.coopBrokerageAddress2,
    coopBrokerageFax: record.coopBrokerageFax,
    listingBrokerageAddress: record.listingBrokerageAddress,
    listingBrokerageAddress2: record.listingBrokerageAddress2,
    listingBrokerageFax: record.listingBrokerageFax,
    coopCommissionAmount: record.coopCommissionAmount,
    coopCommissionTerms: record.coopCommissionTerms,
    sellerBrokerageCommentsSingle: record.sellerBrokerageCommentsSingle,
    sellerBrokerageCommentsMultiple: record.sellerBrokerageCommentsMultiple,
    coopBrokerageComments: record.coopBrokerageComments,
    offerSubmittedHow: record.offerSubmittedHow,
    offerSubmittedTime: record.offerSubmittedTime,
    offerSubmittedDate: toDateOnly(record.offerSubmittedDate),
    counterOfferBuyerNames: record.counterOfferBuyerNames,
    counterOfferSubmittedHow: record.counterOfferSubmittedHow,
    counterOfferSubmittedTime: record.counterOfferSubmittedTime,
    counterOfferSubmittedDate: toDateOnly(record.counterOfferSubmittedDate),
    counterOfferIrrevocableTime: record.counterOfferIrrevocableTime,
    counterOfferIrrevocableDate: toDateOnly(record.counterOfferIrrevocableDate),
    sellerContact: record.sellerContact,
    offerReceivedHow: record.offerReceivedHow,
    offerReceivedTime: record.offerReceivedTime,
    offerReceivedDate: toDateOnly(record.offerReceivedDate),
    offerPresentedHow: record.offerPresentedHow,
    offerPresentedTime: record.offerPresentedTime,
    offerPresentedDate: toDateOnly(record.offerPresentedDate),
    offerComments: record.offerComments,

    designatedRepresentatives: record.designatedRepresentatives,
    commencementTime: record.commencementTime,
    commencementDate: toDateOnly(record.commencementDate),
    expiryDate: toDateOnly(record.expiryDate),
    buyerRequirementsPropertyType: record.buyerRequirementsPropertyType,
    buyerRequirementsGeographicLocation: record.buyerRequirementsGeographicLocation,
    additionalSchedulesList: record.additionalSchedulesList,
    commissionPercent: record.commissionPercent,
    commissionAlternative: record.commissionAlternative,
    commissionLease: record.commissionLease,
    holdoverPeriodDays: record.holdoverPeriodDays,
    sellerLawyerName: record.sellerLawyerName,
    sellerLawyerAddress: record.sellerLawyerAddress,
    sellerLawyerEmail: record.sellerLawyerEmail,
    sellerLawyerTel: record.sellerLawyerTel,
    sellerLawyerFax: record.sellerLawyerFax,
    buyerLawyerName: record.buyerLawyerName,
    buyerLawyerAddress: record.buyerLawyerAddress,
    buyerLawyerEmail: record.buyerLawyerEmail,
    buyerLawyerTel: record.buyerLawyerTel,
    buyerLawyerFax: record.buyerLawyerFax,
    updatedAt: record.updatedAt.toISOString()
})

/**
 * The entries of a transaction that has none.
 *
 * Every field null rather than a 404. The entries exist as soon as the
 * transaction does — they are simply empty — and a form that has to handle
 * "no row yet" separately from "row with nothing in it" is a form with two
 * empty states and one of them untested.
 */
const emptyEntries = (transactionId: string, updatedAt: Date): TransactionEntries => ({
    transactionId,
    agreementDate: null,
    purchasePrice: null,
    purchasePriceWords: null,
    depositTiming: null,
    depositAmount: null,
    depositAmountWords: null,
    depositHolder: null,
    schedulesList: null,
    irrevocabilityBoundParty: null,
    irrevocabilityTime: null,
    irrevocabilityDate: null,
    completionDate: null,
    titleSearchDate: null,
    noticesSellerFax: null,
    noticesBuyerFax: null,
    chattelsIncluded: [],
    fixturesExcluded: [],
    rentalItems: [],
    hstTreatment: null,
    propertyPresentUse: null,
    listingBrokerageName: null,
    listingBrokerageTel: null,
    listingBrokerageSalesperson: null,
    coopBrokerageName: null,
    coopBrokerageTel: null,
    coopBrokerageSalesperson: null,
    coopBrokerageAddress: null,
    coopBrokerageAddress2: null,
    coopBrokerageFax: null,
    listingBrokerageAddress: null,
    listingBrokerageAddress2: null,
    listingBrokerageFax: null,
    coopCommissionAmount: null,
    coopCommissionTerms: null,
    sellerBrokerageCommentsSingle: null,
    sellerBrokerageCommentsMultiple: null,
    coopBrokerageComments: null,
    offerSubmittedHow: null,
    offerSubmittedTime: null,
    offerSubmittedDate: null,
    counterOfferBuyerNames: null,
    counterOfferSubmittedHow: null,
    counterOfferSubmittedTime: null,
    counterOfferSubmittedDate: null,
    counterOfferIrrevocableTime: null,
    counterOfferIrrevocableDate: null,
    sellerContact: null,
    offerReceivedHow: null,
    offerReceivedTime: null,
    offerReceivedDate: null,
    offerPresentedHow: null,
    offerPresentedTime: null,
    offerPresentedDate: null,
    offerComments: null,

    designatedRepresentatives: null,
    commencementTime: null,
    commencementDate: null,
    expiryDate: null,
    buyerRequirementsPropertyType: null,
    buyerRequirementsGeographicLocation: null,
    additionalSchedulesList: null,
    commissionPercent: null,
    commissionAlternative: null,
    commissionLease: null,
    holdoverPeriodDays: null,
    sellerLawyerName: null,
    sellerLawyerAddress: null,
    sellerLawyerEmail: null,
    sellerLawyerTel: null,
    sellerLawyerFax: null,
    buyerLawyerName: null,
    buyerLawyerAddress: null,
    buyerLawyerEmail: null,
    buyerLawyerTel: null,
    buyerLawyerFax: null,
    updatedAt: updatedAt.toISOString()
})

const ownedTransaction = (transactionId: string, agentId: string) =>
    prisma.transaction.findFirst({
        where: { id: transactionId, agentId },
        select: { id: true, updatedAt: true }
    })

/**
 * The entries on a transaction the caller owns.
 *
 * Throws `TransactionNotFoundError` for a transaction that does not exist and
 * for one belonging to another agent alike — which of the two it was is not
 * something the caller gets to learn.
 */
export const getTransactionEntries = async (
    transactionId: string,
    agentId: string
): Promise<TransactionEntries> => {
    const transaction = await ownedTransaction(transactionId, agentId)

    if (!transaction) {
        throw new TransactionNotFoundError()
    }

    const record = await prisma.transactionEntries.findUnique({
        where: { transactionId },
        select: entriesSelect
    })

    return record ? toEntries(record) : emptyEntries(transactionId, transaction.updatedAt)
}

/**
 * A PUT body as columns.
 *
 * An absent field is a cleared field, so `undefined` is normalised to `null`
 * here rather than being left for Prisma to read as "leave it alone" — that is
 * what makes the whole-form write true in the database and not only in the
 * request. The lists behave the same way: an absent one is an emptied one.
 */
const toColumns = (input: SaveTransactionEntriesRequest) => ({
    agreementDate: fromDateOnly(input.agreementDate),
    purchasePrice: input.purchasePrice ?? null,
    purchasePriceWords: input.purchasePriceWords ?? null,
    depositTiming: input.depositTiming ?? null,
    depositAmount: input.depositAmount ?? null,
    depositAmountWords: input.depositAmountWords ?? null,
    depositHolder: input.depositHolder ?? null,
    schedulesList: input.schedulesList ?? null,
    irrevocabilityBoundParty: input.irrevocabilityBoundParty ?? null,
    irrevocabilityTime: input.irrevocabilityTime ?? null,
    irrevocabilityDate: fromDateOnly(input.irrevocabilityDate),
    completionDate: fromDateOnly(input.completionDate),
    titleSearchDate: fromDateOnly(input.titleSearchDate),
    noticesSellerFax: input.noticesSellerFax ?? null,
    noticesBuyerFax: input.noticesBuyerFax ?? null,
    chattelsIncluded: input.chattelsIncluded ?? [],
    fixturesExcluded: input.fixturesExcluded ?? [],
    rentalItems: input.rentalItems ?? [],
    hstTreatment: input.hstTreatment ?? null,
    propertyPresentUse: input.propertyPresentUse ?? null,
    listingBrokerageName: input.listingBrokerageName ?? null,
    listingBrokerageTel: input.listingBrokerageTel ?? null,
    listingBrokerageSalesperson: input.listingBrokerageSalesperson ?? null,
    coopBrokerageName: input.coopBrokerageName ?? null,
    coopBrokerageTel: input.coopBrokerageTel ?? null,
    coopBrokerageSalesperson: input.coopBrokerageSalesperson ?? null,
    coopBrokerageAddress: input.coopBrokerageAddress ?? null,
    coopBrokerageAddress2: input.coopBrokerageAddress2 ?? null,
    coopBrokerageFax: input.coopBrokerageFax ?? null,
    listingBrokerageAddress: input.listingBrokerageAddress ?? null,
    listingBrokerageAddress2: input.listingBrokerageAddress2 ?? null,
    listingBrokerageFax: input.listingBrokerageFax ?? null,
    coopCommissionAmount: input.coopCommissionAmount ?? null,
    coopCommissionTerms: input.coopCommissionTerms ?? null,
    sellerBrokerageCommentsSingle: input.sellerBrokerageCommentsSingle ?? null,
    sellerBrokerageCommentsMultiple: input.sellerBrokerageCommentsMultiple ?? null,
    coopBrokerageComments: input.coopBrokerageComments ?? null,
    offerSubmittedHow: input.offerSubmittedHow ?? null,
    offerSubmittedTime: input.offerSubmittedTime ?? null,
    offerSubmittedDate: fromDateOnly(input.offerSubmittedDate),
    counterOfferBuyerNames: input.counterOfferBuyerNames ?? null,
    counterOfferSubmittedHow: input.counterOfferSubmittedHow ?? null,
    counterOfferSubmittedTime: input.counterOfferSubmittedTime ?? null,
    counterOfferSubmittedDate: fromDateOnly(input.counterOfferSubmittedDate),
    counterOfferIrrevocableTime: input.counterOfferIrrevocableTime ?? null,
    counterOfferIrrevocableDate: fromDateOnly(input.counterOfferIrrevocableDate),
    sellerContact: input.sellerContact ?? null,
    offerReceivedHow: input.offerReceivedHow ?? null,
    offerReceivedTime: input.offerReceivedTime ?? null,
    offerReceivedDate: fromDateOnly(input.offerReceivedDate),
    offerPresentedHow: input.offerPresentedHow ?? null,
    offerPresentedTime: input.offerPresentedTime ?? null,
    offerPresentedDate: fromDateOnly(input.offerPresentedDate),
    offerComments: input.offerComments ?? null,

    designatedRepresentatives: input.designatedRepresentatives ?? null,
    commencementTime: input.commencementTime ?? null,
    commencementDate: fromDateOnly(input.commencementDate) ?? null,
    expiryDate: fromDateOnly(input.expiryDate) ?? null,
    buyerRequirementsPropertyType: input.buyerRequirementsPropertyType ?? null,
    buyerRequirementsGeographicLocation: input.buyerRequirementsGeographicLocation ?? null,
    additionalSchedulesList: input.additionalSchedulesList ?? null,
    commissionPercent: input.commissionPercent ?? null,
    commissionAlternative: input.commissionAlternative ?? null,
    commissionLease: input.commissionLease ?? null,
    holdoverPeriodDays: input.holdoverPeriodDays ?? null,
    sellerLawyerName: input.sellerLawyerName ?? null,
    sellerLawyerAddress: input.sellerLawyerAddress ?? null,
    sellerLawyerEmail: input.sellerLawyerEmail ?? null,
    sellerLawyerTel: input.sellerLawyerTel ?? null,
    sellerLawyerFax: input.sellerLawyerFax ?? null,
    buyerLawyerName: input.buyerLawyerName ?? null,
    buyerLawyerAddress: input.buyerLawyerAddress ?? null,
    buyerLawyerEmail: input.buyerLawyerEmail ?? null,
    buyerLawyerTel: input.buyerLawyerTel ?? null,
    buyerLawyerFax: input.buyerLawyerFax ?? null
})

/**
 * Save the entries on a transaction. Created on the first call, replaced in
 * place afterwards — one row per transaction, enforced by a unique constraint
 * rather than by this function being careful.
 */
export const saveTransactionEntries = async (
    transactionId: string,
    agentId: string,
    input: SaveTransactionEntriesRequest
): Promise<TransactionEntries> => {
    const transaction = await ownedTransaction(transactionId, agentId)

    if (!transaction) {
        throw new TransactionNotFoundError()
    }

    const columns = toColumns(input)

    const record = await prisma.transactionEntries.upsert({
        where: { transactionId },
        update: columns,
        create: { transactionId, ...columns },
        select: entriesSelect
    })

    return toEntries(record)
}

/**
 * Entries as the field mapper wants them (build plan 2.2).
 *
 * The mapper is keyed by the names the curated template gives its blanks, so
 * this is where a column name becomes a blank name. It is the only translation
 * between the two, and it is deliberately dumb: no defaulting, no deriving —
 * the mapper does that, from these.
 *
 * Three things worth knowing:
 *
 * - `agreementDate` arrives as `agreement.date` and the mapper splits it into
 *   the day, month and year the form prints separately. Same for the other
 *   three dates. Schedule A is not here: it follows the agreement's date.
 * - the money fields arrive as the plain figure and the mapper formats them —
 *   grouped, two decimals, no symbol — because that rule belongs in one place.
 * - the ruled blocks arrive as one joined string under the block's own name,
 *   not as `.lineN` keys. That hands the wrapping to the fill engine, which is
 *   the only part of this with the font metrics; writing the lines here would
 *   put a long chattel list's first line into a blank too narrow for it and
 *   report nothing wrong.
 */
export const toEntryInput = (entries: TransactionEntries): EntryInput => {
    const list = (items: string[]) => (items.length === 0 ? undefined : items.join(', '))

    return {
        'agreement.date': entries.agreementDate,

        purchasePrice: entries.purchasePrice,
        'purchasePrice.words': entries.purchasePriceWords,

        'deposit.timing': entries.depositTiming,
        'deposit.amount': entries.depositAmount,
        'deposit.amountWords': entries.depositAmountWords,
        'deposit.holder': entries.depositHolder,

        'schedules.list': entries.schedulesList,

        'irrevocability.boundParty': entries.irrevocabilityBoundParty,
        'irrevocability.time': entries.irrevocabilityTime,
        'irrevocability.date': entries.irrevocabilityDate,

        'completion.date': entries.completionDate,
        'titleSearch.date': entries.titleSearchDate,

        'notices.sellerFax': entries.noticesSellerFax,
        'notices.buyerFax': entries.noticesBuyerFax,

        chattelsIncluded: list(entries.chattelsIncluded),
        fixturesExcluded: list(entries.fixturesExcluded),
        rentalItems: list(entries.rentalItems),

        'hst.treatment': entries.hstTreatment,

        'property.presentUse': entries.propertyPresentUse,

        'listingBrokerage.name': entries.listingBrokerageName,
        'listingBrokerage.tel': entries.listingBrokerageTel,
        'listingBrokerage.salesperson': entries.listingBrokerageSalesperson,
        'coopBrokerage.name': entries.coopBrokerageName,
        'coopBrokerage.tel': entries.coopBrokerageTel,
        'coopBrokerage.salesperson': entries.coopBrokerageSalesperson,

        // Form 320. The two comment blocks and the commission terms are ruled
        // continuation lines on the paper; they go over as one string under the
        // block name and the fill engine wraps them, the same way the chattels
        // block works on Form 100.
        'coopBrokerage.address.line1': entries.coopBrokerageAddress,
        'coopBrokerage.address.line2': entries.coopBrokerageAddress2,
        'coopBrokerage.fax': entries.coopBrokerageFax,
        'listingBrokerage.address.line1': entries.listingBrokerageAddress,
        'listingBrokerage.address.line2': entries.listingBrokerageAddress2,
        'listingBrokerage.fax': entries.listingBrokerageFax,
        'coopCommission.amount': entries.coopCommissionAmount,
        'coopCommission.terms': entries.coopCommissionTerms,
        'sellerBrokerage.commentsSingle': entries.sellerBrokerageCommentsSingle,
        'sellerBrokerage.commentsMultiple': entries.sellerBrokerageCommentsMultiple,
        'coopBrokerage.comments': entries.coopBrokerageComments,

        // Form 801. The `.date` keys fan out into the day / month / year the
        // form prints separately — that rule is generic in the mapper, so a
        // date column named this way needs nothing added there.
        'offerSubmitted.how': entries.offerSubmittedHow,
        'offerSubmitted.time': entries.offerSubmittedTime,
        'offerSubmitted.date': entries.offerSubmittedDate,

        'counterOffer.buyer.fullLegalNames': entries.counterOfferBuyerNames,
        'counterOfferSubmitted.how': entries.counterOfferSubmittedHow,
        'counterOfferSubmitted.time': entries.counterOfferSubmittedTime,
        'counterOfferSubmitted.date': entries.counterOfferSubmittedDate,
        'counterOfferIrrevocable.time': entries.counterOfferIrrevocableTime,
        'counterOfferIrrevocable.date': entries.counterOfferIrrevocableDate,

        'seller.contact': entries.sellerContact,
        'offerReceived.how': entries.offerReceivedHow,
        'offerReceived.time': entries.offerReceivedTime,
        'offerReceived.date': entries.offerReceivedDate,
        'offerPresented.how': entries.offerPresentedHow,
        'offerPresented.time': entries.offerPresentedTime,
        'offerPresented.date': entries.offerPresentedDate,
        'offer.comments': entries.offerComments,

        // Form 371. `commencement.date` and `expiry.date` go over as dates and
        // the mapper fans each into the day, month and year the form prints
        // separately — the same generic split `agreement.date` gets. The two
        // requirement blocks are ruled continuation lines, so they travel as
        // one string under the block name and the fill engine wraps them.
        designatedRepresentatives: entries.designatedRepresentatives,
        'commencement.time': entries.commencementTime,
        'commencement.date': entries.commencementDate,
        'expiry.date': entries.expiryDate,
        'buyerRequirements.propertyType': entries.buyerRequirementsPropertyType,
        'buyerRequirements.geographicLocation': entries.buyerRequirementsGeographicLocation,
        'additionalSchedules.list': entries.additionalSchedulesList,
        'commission.percent': entries.commissionPercent,
        'commission.alternative': entries.commissionAlternative,
        'commission.lease': entries.commissionLease,
        'holdoverPeriod.days': entries.holdoverPeriodDays,

        'sellerLawyer.name': entries.sellerLawyerName,
        'sellerLawyer.address': entries.sellerLawyerAddress,
        'sellerLawyer.email': entries.sellerLawyerEmail,
        'sellerLawyer.tel': entries.sellerLawyerTel,
        'sellerLawyer.fax': entries.sellerLawyerFax,

        'buyerLawyer.name': entries.buyerLawyerName,
        'buyerLawyer.address': entries.buyerLawyerAddress,
        'buyerLawyer.email': entries.buyerLawyerEmail,
        'buyerLawyer.tel': entries.buyerLawyerTel,
        'buyerLawyer.fax': entries.buyerLawyerFax
    }
}

/**
 * The entries of a transaction, already shaped for the mapper. What the fill
 * engine and the compliance gate both call.
 */
export const loadEntryInput = async (
    transactionId: string,
    agentId: string
): Promise<EntryInput> => toEntryInput(await getTransactionEntries(transactionId, agentId))
