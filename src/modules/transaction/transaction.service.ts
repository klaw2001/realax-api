import { TransactionStatus, TransactionType } from '@prisma/client'

import prisma from '@/lib/prisma'
import type { Transaction } from '@/schemas/transaction'

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
 * The caller's transactions, newest first.
 *
 * `agentId` is a parameter rather than a filter the caller supplies, so there
 * is no code path here that can return another agent's work.
 */
export const listTransactions = async (agentId: string): Promise<Transaction[]> => {
    const records = await prisma.transaction.findMany({
        where: { agentId },
        select: transactionSelect,
        orderBy: { createdAt: 'desc' }
    })

    return records.map(toTransaction)
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
