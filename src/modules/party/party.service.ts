import type { PartyRole as PrismaPartyRole } from '@prisma/client'

import prisma from '@/lib/prisma'
import type { CreatePartyRequest, Party, UpdatePartyRequest } from '@/schemas/party'

/**
 * Parties (build plan 1.5).
 *
 * The unit this module works in is `TransactionParty` — a person in a role on
 * one transaction — with the `Party` person record joined in. The API publishes
 * the two flattened into one object, because the frontend edits them as one
 * form and the field mapper in build plan 2.2 wants one flat object per party.
 *
 * Every function takes an `agentId` and filters on it inside the query rather
 * than checking ownership after reading, so there is no code path here that
 * loads another agent's party and then decides what to do about it.
 */

/**
 * The columns the API publishes. Note what is absent: `IdentityRecord` is not
 * joined. Licence numbers and scan S3 keys are not party details, and this
 * service has no reason to be able to read them.
 */
const partySelect = {
    id: true,
    partyId: true,
    role: true,
    signingOrder: true,
    createdAt: true,
    party: {
        select: {
            fullLegalName: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            province: true,
            postalCode: true,
            dateOfBirth: true,
            updatedAt: true
        }
    }
} as const

type PartyRecord = {
    id: string
    partyId: string
    role: PrismaPartyRole
    signingOrder: number | null
    createdAt: Date
    party: {
        fullLegalName: string
        email: string | null
        phone: string | null
        address: string | null
        city: string | null
        province: string | null
        postalCode: string | null
        dateOfBirth: Date | null
        updatedAt: Date
    }
}

/**
 * A Postgres `DATE` back as `YYYY-MM-DD`.
 *
 * Prisma hands these back as a Date at UTC midnight, so the ISO string's date
 * half is the date that was stored. Formatting it in local time instead would
 * move a birth date by a day for anyone west of Greenwich.
 */
const toDateOnly = (value: Date | null) => (value === null ? null : value.toISOString().slice(0, 10))

/**
 * `YYYY-MM-DD` as the instant Prisma stores in a `DATE` column.
 *
 * `null` and `undefined` pass through unchanged, so a PATCH clearing the field
 * and a PATCH not mentioning it stay distinguishable all the way to Prisma.
 */
const fromDateOnly = (value: string | null | undefined) =>
    value === null || value === undefined ? value : new Date(`${value}T00:00:00.000Z`)

/** Prisma rows → the shape published in `openapi.json`. */
const toParty = (record: PartyRecord): Party => ({
    id: record.id,
    personId: record.partyId,
    role: record.role,
    signingOrder: record.signingOrder,
    fullLegalName: record.party.fullLegalName,
    email: record.party.email,
    phone: record.party.phone,
    address: record.party.address,
    city: record.party.city,
    province: record.party.province,
    postalCode: record.party.postalCode,
    dateOfBirth: toDateOnly(record.party.dateOfBirth),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.party.updatedAt.toISOString()
})

/**
 * The transaction, if the caller owns it. Ownership is a filter on the query
 * rather than a check after it.
 */
const ownedTransaction = (transactionId: string, agentId: string) =>
    prisma.transaction.findFirst({
        where: { id: transactionId, agentId },
        select: { id: true }
    })

/**
 * One live party on a transaction the caller owns.
 *
 * The three conditions are one `where` on purpose: a party on someone else's
 * transaction, a party that was removed, and a party that never existed are the
 * same answer, and none of them is distinguishable to the caller.
 */
const ownedParty = (transactionId: string, agentId: string, partyId: string) =>
    prisma.transactionParty.findFirst({
        where: {
            id: partyId,
            deletedAt: null,
            transaction: { id: transactionId, agentId }
        },
        // `partyId` comes back so an update can reach the person record without
        // a second round trip to find out which one it is.
        select: { id: true, partyId: true }
    })

/**
 * The parties on a transaction, or `null` when the transaction is not the
 * caller's — which the controller answers as a 404, the same as a transaction
 * that does not exist.
 *
 * An empty array and `null` mean different things: a transaction with no
 * parties yet is a normal state and is not an error.
 */
export const listTransactionParties = async (
    transactionId: string,
    agentId: string
): Promise<Party[] | null> => {
    const transaction = await ownedTransaction(transactionId, agentId)

    if (!transaction) {
        return null
    }

    const records = await prisma.transactionParty.findMany({
        where: { transactionId, deletedAt: null },
        select: partySelect,
        // Signing order first, because that is the order the forms and the
        // signing flow use. Nulls last so parties without an assigned position
        // do not displace the ones that have one; `createdAt` breaks the tie so
        // the list does not reshuffle between reads.
        orderBy: [{ signingOrder: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }]
    })

    return records.map(toParty)
}

/**
 * Add a party to a transaction. `null` when the transaction is not the
 * caller's.
 *
 * A new person record every time. Matching an incoming name against people
 * already in the database would silently join two transactions to one identity,
 * and deciding when two names are the same person is exactly the question the
 * identity-verification work in build plan 2.5 exists to answer — see
 * NEEDS-KLAW. Until then, a person added twice is two records, which is
 * recoverable; a wrong merge is not.
 *
 * Both rows are written in one database transaction: a person record attached
 * to nothing is invisible to the agent and impossible to find again.
 */
export const createTransactionParty = async (
    transactionId: string,
    agentId: string,
    input: CreatePartyRequest
): Promise<Party | null> => {
    const transaction = await ownedTransaction(transactionId, agentId)

    if (!transaction) {
        return null
    }

    const record = await prisma.transactionParty.create({
        data: {
            // `connect` rather than a bare `transactionId`: Prisma takes scalar
            // foreign keys and nested writes as two different input shapes, and
            // the person below has to be a nested write to be created here.
            transaction: { connect: { id: transaction.id } },
            role: input.role,
            signingOrder: input.signingOrder ?? null,
            party: {
                create: {
                    fullLegalName: input.fullLegalName,
                    email: input.email ?? null,
                    phone: input.phone ?? null,
                    address: input.address ?? null,
                    city: input.city ?? null,
                    province: input.province ?? null,
                    postalCode: input.postalCode ?? null,
                    dateOfBirth: fromDateOnly(input.dateOfBirth) ?? null
                }
            }
        },
        select: partySelect
    })

    return toParty(record)
}

/** One party on a transaction, or `null` if there is no such live party. */
export const getTransactionParty = async (
    transactionId: string,
    agentId: string,
    partyId: string
): Promise<Party | null> => {
    const record = await prisma.transactionParty.findFirst({
        where: {
            id: partyId,
            deletedAt: null,
            transaction: { id: transactionId, agentId }
        },
        select: partySelect
    })

    return record === null ? null : toParty(record)
}

/**
 * Apply a partial update, or `null` if there is no such live party.
 *
 * `undefined` reaches Prisma as "no change" and `null` as "clear the column",
 * which is the PATCH semantics the schema declares — so the request body maps
 * across without a field-by-field translation. `dateOfBirth` is the one
 * exception, because it crosses a type boundary on the way in.
 *
 * The role and signing order live on the pairing, the identity fields on the
 * person; both are written in one database transaction so a half-applied edit
 * cannot leave a party whose role moved but whose name did not.
 */
export const updateTransactionParty = async (
    transactionId: string,
    agentId: string,
    partyId: string,
    changes: UpdatePartyRequest
): Promise<Party | null> => {
    const existing = await ownedParty(transactionId, agentId, partyId)

    if (!existing) {
        return null
    }

    return prisma.$transaction(async tx => {
        await tx.party.update({
            where: { id: existing.partyId },
            data: {
                fullLegalName: changes.fullLegalName,
                email: changes.email,
                phone: changes.phone,
                address: changes.address,
                city: changes.city,
                province: changes.province,
                postalCode: changes.postalCode,
                dateOfBirth: fromDateOnly(changes.dateOfBirth)
            }
        })

        const record = await tx.transactionParty.update({
            where: { id: existing.id },
            data: {
                role: changes.role,
                signingOrder: changes.signingOrder
            },
            select: partySelect
        })

        return toParty(record)
    })
}

/**
 * Remove a party from a transaction. `false` if there is no such live party.
 *
 * Soft: the pairing is stamped and stops being read, and the person record is
 * left alone. Two reasons it is not a hard delete — the same person may be on
 * another transaction, and identity records hang off the person under a
 * five-year FINTRAC retention. Nothing here is destructive.
 */
export const softDeleteTransactionParty = async (
    transactionId: string,
    agentId: string,
    partyId: string
): Promise<boolean> => {
    const existing = await ownedParty(transactionId, agentId, partyId)

    if (!existing) {
        return false
    }

    await prisma.transactionParty.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() }
    })

    return true
}
