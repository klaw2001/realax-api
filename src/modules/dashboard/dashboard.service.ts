import { TransactionStatus } from '@prisma/client'

import prisma from '@/lib/prisma'
import { listItemSelect, toListItem } from '@/modules/transaction/transaction.service'
import type { AttentionItem, DashboardResponse } from '@/schemas/dashboard'

/**
 * The agent's home page, in one query set (UX plan item 08).
 *
 * The rule the shape follows: **actionable first, counts second, history
 * last.** An agent opening this app wants to know what needs them today.
 *
 * Everything here is scoped by `agentId`, passed in rather than taken from a
 * filter, so there is no code path that reads another agent's work.
 */

/** A draft nobody has touched in this long is worth mentioning. */
const STALE_DRAFT_DAYS = 14

/**
 * How many rows the attention list may carry.
 *
 * A cap rather than a page. This is a list to act on before lunch; an agent
 * with forty blocked transactions has a different problem, and scrolling
 * forty rows on a home page is not the fix for it.
 */
const ATTENTION_LIMIT = 8

/** How many recent transactions the home page shows. */
const RECENT_LIMIT = 5

/**
 * Most blocking first.
 *
 * Compliance failures come first because they are the ones stopping a document
 * from being produced at all. Identity is next: it is FINTRAC exposure rather
 * than a stuck deal, so it is urgent in a different way. A stale draft is last
 * — it is a nudge, not a problem.
 */
const KIND_ORDER: Record<AttentionItem['kind'], number> = {
    compliance_blocked: 0,
    identity_missing: 1,
    stale_draft: 2
}

const startOfMonth = (): Date => {
    const at = new Date()

    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
}

const daysAgo = (days: number): Date => {
    const at = new Date()

    at.setUTCDate(at.getUTCDate() - days)

    return at
}

/**
 * Transactions whose most recent compliance check failed.
 *
 * The most recent one per form is what counts. A transaction that failed a
 * check on Monday and passed on Tuesday is not blocked, and reading every
 * failing check ever recorded would say it was — so the checks come back newest
 * first and only the first one seen for each form is believed.
 */
const complianceBlocked = async (agentId: string): Promise<AttentionItem[]> => {
    const checks = await prisma.complianceCheck.findMany({
        where: { transactionForm: { transaction: { agentId } } },
        orderBy: { checkedAt: 'desc' },
        select: {
            passed: true,
            missingFields: true,
            transactionFormId: true,
            transactionForm: {
                select: {
                    transactionId: true,
                    transaction: { select: { property: { select: { address: true } } } }
                }
            }
        }
    })

    const seenForms = new Set<string>()
    const byTransaction = new Map<string, AttentionItem>()

    for (const check of checks) {
        if (seenForms.has(check.transactionFormId)) {
            continue
        }

        seenForms.add(check.transactionFormId)

        if (check.passed) {
            continue
        }

        const transactionId = check.transactionForm.transactionId
        const missing = Array.isArray(check.missingFields) ? check.missingFields.length : 0

        // A transaction with two blocked forms is one row, carrying the total.
        // Two rows for one deal would push somebody else's off the list.
        const existing = byTransaction.get(transactionId)

        byTransaction.set(transactionId, {
            kind: 'compliance_blocked',
            transactionId,
            address: check.transactionForm.transaction.property?.address ?? null,
            count: (existing?.count ?? 0) + missing
        })
    }

    return [...byTransaction.values()].filter(item => item.count > 0)
}

/**
 * Transactions carrying a party with no identity record at all.
 *
 * Counted against the person rather than the party row, which is how records
 * are held — somebody verified on an earlier deal is already verified here, and
 * asking them twice is what build plan 2.5 exists to stop.
 *
 * An expired record is deliberately not counted as missing. It is a different
 * problem with a different fix, the parties table already says so in its own
 * words, and a home page that called it "no identity record" would send the
 * agent looking for something that is on file.
 */
const identityMissing = async (agentId: string): Promise<AttentionItem[]> => {
    const parties = await prisma.transactionParty.findMany({
        where: {
            deletedAt: null,
            transaction: { agentId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
            party: { identityRecords: { none: {} } }
        },
        select: {
            transactionId: true,
            transaction: { select: { property: { select: { address: true } } } }
        }
    })

    const byTransaction = new Map<string, AttentionItem>()

    for (const party of parties) {
        const existing = byTransaction.get(party.transactionId)

        byTransaction.set(party.transactionId, {
            kind: 'identity_missing',
            transactionId: party.transactionId,
            address: party.transaction.property?.address ?? null,
            count: (existing?.count ?? 0) + 1
        })
    }

    return [...byTransaction.values()]
}

/** Drafts nobody has touched. `count` is how many days it has been sitting. */
const staleDrafts = async (agentId: string): Promise<AttentionItem[]> => {
    const cutoff = daysAgo(STALE_DRAFT_DAYS)

    const drafts = await prisma.transaction.findMany({
        where: { agentId, status: 'DRAFT', updatedAt: { lt: cutoff } },
        orderBy: { updatedAt: 'asc' },
        take: ATTENTION_LIMIT,
        select: { id: true, updatedAt: true, property: { select: { address: true } } }
    })

    const now = Date.now()

    return drafts.map(draft => ({
        kind: 'stale_draft' as const,
        transactionId: draft.id,
        address: draft.property?.address ?? null,
        count: Math.floor((now - draft.updatedAt.getTime()) / (24 * 60 * 60 * 1000))
    }))
}

export const loadDashboard = async (agentId: string): Promise<DashboardResponse> => {
    const [grouped, completedThisMonth, recentRecords, blocked, missing, stale] = await Promise.all([
        prisma.transaction.groupBy({
            by: ['status'],
            where: { agentId },
            _count: { _all: true }
        }),
        prisma.transaction.count({
            where: { agentId, status: 'COMPLETED', updatedAt: { gte: startOfMonth() } }
        }),
        prisma.transaction.findMany({
            where: { agentId },
            select: listItemSelect,
            orderBy: { updatedAt: 'desc' },
            take: RECENT_LIMIT
        }),
        complianceBlocked(agentId),
        identityMissing(agentId),
        staleDrafts(agentId)
    ])

    // Every status, including the ones at zero: a row of tiles that changes
    // shape as the day goes on is harder to read than one that does not, and
    // "no drafts" is worth seeing.
    const statusCounts = Object.fromEntries(
        Object.values(TransactionStatus).map(status => [
            status,
            grouped.find(row => row.status === status)?._count._all ?? 0
        ])
    ) as DashboardResponse['statusCounts']

    const attention = [...blocked, ...missing, ...stale]
        .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.count - a.count)
        .slice(0, ATTENTION_LIMIT)

    return {
        statusCounts,
        completedThisMonth,
        attention,
        recent: recentRecords.map(toListItem)
    }
}
