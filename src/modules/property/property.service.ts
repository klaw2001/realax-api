import prisma from '@/lib/prisma'
import { getListing, searchListings } from '@/integrations/repliers/client'
import type { RepliersListing } from '@/integrations/repliers/schema'
import type {
    Property,
    PropertyDraft,
    PropertySearchResponse,
    PropertySearchResult,
    SavePropertyRequest
} from '@/schemas/property'

/**
 * Property entry (build plan 1.4).
 *
 * Two halves that stay apart on purpose: mapping an MLS listing onto the OREA
 * property fields, and persisting what the agent finally approved. The mapping
 * never writes, so an autofill costs nothing and a re-search cannot overwrite
 * an edit the agent has already made.
 */

/** Joined with single spaces, with blanks dropped. `null` when nothing is left. */
const join = (...parts: (string | null | undefined)[]) => {
    const text = parts
        .map(part => part?.trim())
        .filter((part): part is string => Boolean(part))
        .join(' ')

    return text === '' ? null : text
}

/**
 * A lot measurement as written on the form.
 *
 * Repliers sends these as a string on some listings and a number on others, and
 * both appear in one sample. Whatever arrives is rendered as written rather than
 * parsed into a number and re-formatted — "irregular" is a legitimate frontage,
 * and a figure the agent recognises is worth more than a tidy one.
 */
const measurement = (value: string | number | null | undefined) => {
    if (value === null || value === undefined) {
        return null
    }

    const text = String(value).trim()

    return text === '' ? null : text
}

/**
 * The street address on one line: unit, number, name, suffix, direction.
 *
 * This is what goes in the OREA address blank, so it is assembled here rather
 * than left to the client — a form that renders the parts in a different order
 * than the one we fill a PDF with would be a difference nobody notices until a
 * document is signed.
 */
const streetAddress = (listing: RepliersListing) => {
    const { unitNumber, streetNumber, streetName, streetSuffix, streetDirection } = listing.address

    const line = join(
        streetNumber,
        streetName,
        streetSuffix,
        streetDirection,
        unitNumber ? `Unit ${unitNumber}` : null
    )

    // `streetNumber` and `streetName` are non-null in the schema, so this only
    // holds if both are empty strings — a listing we cannot address.
    return line ?? ''
}

/**
 * Annual taxes as text.
 *
 * The column is a string because OREA forms carry the figure as written, and
 * because the amount is null on every listing the sandbox key returns. Formatted
 * with thousands separators and two decimals, which is how it appears on the
 * form; the agent can overwrite it.
 */
const annualTaxes = (listing: RepliersListing) => {
    const amount = listing.taxes?.annualAmount

    if (amount === null || amount === undefined) {
        return null
    }

    return amount.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * MLS listing → the property form.
 *
 * `frontingSide` has no MLS source at all — it is the "on the ___ side of" blank
 * and comes from the agent. `frontage` and `depth` are null on every sandbox
 * listing, so the form has to survive them being empty rather than treat autofill
 * as complete. Nothing here invents a value to fill a gap.
 */
export const toPropertyDraft = (listing: RepliersListing): PropertyDraft => ({
    mlsNumber: listing.mlsNumber,
    address: streetAddress(listing),
    city: listing.address.city,

    // Repliers calls it `state`; for a Canadian board it carries the province.
    province: listing.address.state,
    postalCode: listing.address.zip ?? null,
    frontingSide: null,
    frontingStreet: join(listing.address.streetName, listing.address.streetSuffix),
    frontage: measurement(listing.lot?.width),
    depth: measurement(listing.lot?.depth),
    legalDescription: listing.lot?.legalDescription ?? null,
    listPrice: Math.round(listing.listPrice),
    taxes: annualTaxes(listing)
})

/** MLS listing → one row of the search dropdown. */
const toSearchResult = (listing: RepliersListing): PropertySearchResult => ({
    mlsNumber: listing.mlsNumber,
    address: streetAddress(listing),
    city: listing.address.city,
    province: listing.address.state,
    listPrice: Math.round(listing.listPrice),
    propertyType: listing.details?.propertyType ?? null
})

/** Search MLS. Everything upstream — key, cache, schema — is in the client. */
export const searchProperties = async (
    query: string,
    limit?: number
): Promise<PropertySearchResponse> => {
    const response = await searchListings(query, limit)

    return {
        results: response.listings.map(toSearchResult),
        count: response.count
    }
}

/** One listing as a property draft, or `null` when there is no such listing. */
export const getPropertyDraft = async (mlsNumber: string): Promise<PropertyDraft | null> => {
    const listing = await getListing(mlsNumber)

    return listing === null ? null : toPropertyDraft(listing)
}

/** The property columns the API publishes. */
const propertySelect = {
    id: true,
    mlsNumber: true,
    address: true,
    city: true,
    province: true,
    postalCode: true,
    frontingSide: true,
    frontingStreet: true,
    frontage: true,
    depth: true,
    legalDescription: true,
    listPrice: true,
    taxes: true
} as const

/**
 * The transaction, if the caller owns it.
 *
 * Ownership is a filter on the query rather than a check after it, so there is
 * no path that reads another agent's transaction and then decides what to do
 * about it.
 */
const ownedTransaction = (transactionId: string, agentId: string) =>
    prisma.transaction.findFirst({
        where: { id: transactionId, agentId },
        select: { id: true, propertyId: true }
    })

/**
 * The saved property, or `null` when the transaction has none — or is not the
 * caller's. Both answer 404 at the controller: which of the two it was is not
 * something a caller who does not own the transaction gets to learn.
 */
export const getTransactionProperty = async (
    transactionId: string,
    agentId: string
): Promise<Property | null> => {
    const transaction = await ownedTransaction(transactionId, agentId)

    if (!transaction?.propertyId) {
        return null
    }

    return prisma.property.findUnique({
        where: { id: transaction.propertyId },
        select: propertySelect
    })
}

/** Raised when the transaction does not exist, or belongs to another agent. */
export class TransactionNotFoundError extends Error {
    constructor() {
        super('No such transaction')
        this.name = 'TransactionNotFoundError'
    }
}

/**
 * Save the property on a transaction.
 *
 * Created and linked on the first call, updated in place afterwards, so an agent
 * editing the form does not leave a trail of orphaned property rows — and the
 * transaction's `propertyId` does not change under a form the agent is still
 * working in.
 *
 * The write and the link are one transaction: a property row that exists but is
 * attached to nothing is invisible to the agent and impossible to find again.
 */
export const saveTransactionProperty = async (
    transactionId: string,
    agentId: string,
    input: SavePropertyRequest
): Promise<Property> => {
    const transaction = await ownedTransaction(transactionId, agentId)

    if (!transaction) {
        throw new TransactionNotFoundError()
    }

    // A PUT carries the whole form, so an absent optional field is a cleared
    // field. Normalising `undefined` to `null` here is what makes that true in
    // the database rather than only in the request.
    const data = {
        mlsNumber: input.mlsNumber ?? null,
        address: input.address,
        city: input.city,
        province: input.province,
        postalCode: input.postalCode ?? null,
        frontingSide: input.frontingSide ?? null,
        frontingStreet: input.frontingStreet ?? null,
        frontage: input.frontage ?? null,
        depth: input.depth ?? null,
        legalDescription: input.legalDescription ?? null,
        listPrice: input.listPrice ?? null,
        taxes: input.taxes ?? null
    }

    if (transaction.propertyId) {
        return prisma.property.update({
            where: { id: transaction.propertyId },
            data,
            select: propertySelect
        })
    }

    return prisma.$transaction(async tx => {
        const property = await tx.property.create({ data, select: propertySelect })

        await tx.transaction.update({
            where: { id: transaction.id },
            data: { propertyId: property.id }
        })

        return property
    })
}
