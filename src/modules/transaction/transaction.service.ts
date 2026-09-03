import { TransactionStatus, TransactionType } from '@prisma/client'

import prisma from '@/lib/prisma'
import type {
    Transaction,
    TransactionListItem,
    TransactionListQuery,
    TransactionListResponse
} from '@/schemas/transaction'

/**
 * The transaction columns the API publishes. Relations — property, parties,
 * forms — are absent here on purpose: they are attached in later tasks and
 * each will say for itself how it is loaded.
 */
const transactionSelect = {
    id: true,
    type: true,
    status: true,
    agentId: true,
    propertyId: true,
    createdAt: true,
    updatedAt: true
} as const

type TransactionRecord = {
    id: string
    type: TransactionType
    status: TransactionStatus
    agentId: string
    propertyId: string | null
    createdAt: Date
    updatedAt: Date
}

/** Prisma row → the shape published in `openapi.json`. */
const toTransaction = (record: TransactionRecord): Transaction => ({
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString()
})

/**
 * The extra columns a list row carries: the address that identifies the deal to
 * a person, and how many parties are still on it.
 */
export const listItemSelect = {
    ...transactionSelect,
    property: { select: { id: true, address: true, city: true, mlsNumber: true } },

    // Filtered, so a removed party stops being counted. `TransactionParty` is
    // soft-deleted precisely because the same person may be on another deal.
    _count: { select: { parties: { where: { deletedAt: null } } } }
} as const

/**
 * The `where` the filters come to.
 *
 * Built once and used twice — for the page and for the total — so the count and
 * the rows can never describe different filters.
 *
 * `agentId` is first and is not derived from anything the caller sent. Every
 * other clause narrows within it, so no combination of query parameters can
 * widen the result past the caller's own transactions.
 */
const listWhere = (agentId: string, query: TransactionListQuery) => {
    const { search, type, status, createdFrom, createdTo } = query

    return {
        agentId,
        ...(type ? { type } : {}),
        ...(status && status.length > 0 ? { status: { in: status } } : {}),

        ...(createdFrom || createdTo
            ? {
                  createdAt: {
                      ...(createdFrom ? { gte: new Date(`${createdFrom}T00:00:00.000Z`) } : {}),

                      // The day named is included. `lt` the next midnight
                      // rather than `lte` the same one, which would match only
                      // transactions created in the first millisecond of it.
                      ...(createdTo ? { lt: nextDay(createdTo) } : {})
                  }
              }
            : {}),

        /*
         * Search is over the property, so a transaction with no property yet
         * cannot match one — which is correct: there is nothing to match
         * against. A draft with no address is found by clearing the search, not
         * by typing into it.
         */
        ...(search
            ? {
                  property: {
                      OR: [
                          { address: { contains: search, mode: 'insensitive' as const } },
                          { city: { contains: search, mode: 'insensitive' as const } },
                          { mlsNumber: { contains: search, mode: 'insensitive' as const } }
                      ]
                  }
              }
            : {})
    }
}

const nextDay = (date: string): Date => {
    const at = new Date(`${date}T00:00:00.000Z`)

    at.setUTCDate(at.getUTCDate() + 1)

    return at
}

export const toListItem = (record: {
    property: { id: string; address: string; city: string; mlsNumber: string | null } | null
    _count: { parties: number }
} & TransactionRecord): TransactionListItem => ({
    ...toTransaction(record),
    property: record.property,
    partyCount: record._count.parties
})

/**
 * The caller's transactions, filtered, ordered and paged.
 *
 * `agentId` is a parameter rather than a filter the caller supplies, so there
 * is no code path here that can return another agent's work.
 *
 * The count runs alongside the page rather than after it: the pager and the
 * empty state both need to know how many matched, and a second round trip for
 * a number is a round trip.
 */
export const listTransactions = async (
    agentId: string,
    query: TransactionListQuery
): Promise<TransactionListResponse> => {
    const where = listWhere(agentId, query)

    const [records, total] = await Promise.all([
        prisma.transaction.findMany({
            where,
            select: listItemSelect,

            // Ordered by `updatedAt` as a tiebreak on status, which is a coarse
            // sort — six values across a whole list would otherwise come back
            // in whatever order the database found them, and a table that
            // reshuffles between page loads reads as broken.
            orderBy:
                query.sort === 'status'
                    ? [{ status: query.direction }, { updatedAt: 'desc' }]
                    : [{ [query.sort]: query.direction }],
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize
        }),
        prisma.transaction.count({ where })
    ])

    return {
        transactions: records.map(toListItem),
        total,
        page: query.page,
        pageSize: query.pageSize
    }
}

/**
 * The transaction does not exist, or belongs to another agent.
 *
 * Defined once, here, because a transaction is what this module owns. It used
 * to be defined separately in each module that needed it, which read as
 * harmless duplication and was not: three classes with one name are three
 * types, and `instanceof` across two of them is false. A controller catching
 * the fill engine's version answered a 500 to a request the entries service
 * had correctly refused. Modules re-export this rather than declaring their
 * own.
 */
export class TransactionNotFoundError extends Error {
    constructor() {
        super('No such transaction')
        this.name = 'TransactionNotFoundError'
    }
}

/**
 * One transaction, if the caller owns it.
 *
 * `null` for a transaction that does not exist and for one belonging to another
 * agent alike: ownership is a filter on the query rather than a check after it,
 * so there is no code path that reads someone else's transaction and then
 * decides what to do about it — and which of the two it was is not something
 * the caller gets to learn.
 */
export const findTransaction = async (
    transactionId: string,
    agentId: string
): Promise<Transaction | null> => {
    const record = await prisma.transaction.findFirst({
        where: { id: transactionId, agentId },
        select: transactionSelect
    })

    return record === null ? null : toTransaction(record)
}

/**
 * Start a DRAFT transaction.
 *
 * The status is not taken from the request: every transaction begins as a
 * draft, and it advances through the compliance gate rather than by being
 * asked to.
 */
export const createListingTransaction = async (agentId: string): Promise<Transaction> => {
    const record = await prisma.transaction.create({
        data: {
            type: TransactionType.LISTING,
            status: TransactionStatus.DRAFT,
            agentId
        },
        select: transactionSelect
    })

    return toTransaction(record)
}
