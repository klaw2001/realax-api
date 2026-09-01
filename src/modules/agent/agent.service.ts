import prisma from '@/lib/prisma'
import { agentSelect, type AgentRecord } from '@/modules/auth/auth.service'
import type { AgentProfile, UpdateAgentProfileRequest } from '@/schemas/agent'
import type { Brokerage } from '@/schemas/brokerage'

/**
 * Profile columns. Built on `agentSelect` — the one place that decides which
 * agent columns may leave the service — plus the brokerage relation, so the
 * password digest stays absent by construction here too.
 */
const profileSelect = {
    ...agentSelect,
    brokerage: {
        select: { id: true, name: true, address: true, phone: true }
    }
} as const

type ProfileRecord = AgentRecord & { brokerage: Brokerage | null }

/** Prisma row → the shape published in `openapi.json`. */
const toProfile = (record: ProfileRecord): AgentProfile => ({
    ...record,
    createdAt: record.createdAt.toISOString(),
    brokerage: record.brokerage
})

/**
 * The brokerage preset table, ordered by name so the select renders in a
 * predictable order rather than in insertion order.
 */
export const listBrokerages = (): Promise<Brokerage[]> =>
    prisma.brokerage.findMany({
        select: { id: true, name: true, address: true, phone: true },
        orderBy: { name: 'asc' }
    })

export const brokerageExists = async (id: string): Promise<boolean> =>
    (await prisma.brokerage.count({ where: { id } })) > 0

export const findProfile = async (agentId: string): Promise<AgentProfile | null> => {
    const record = await prisma.agent.findUnique({ where: { id: agentId }, select: profileSelect })

    return record ? toProfile(record) : null
}

/**
 * Apply a partial update.
 *
 * `undefined` reaches Prisma as "no change" and `null` as "clear the column",
 * which is exactly the PATCH semantics the schema declares — so the request
 * body maps across without a field-by-field translation.
 */
export const updateProfile = async (
    agentId: string,
    changes: UpdateAgentProfileRequest
): Promise<AgentProfile> => {
    const record = await prisma.agent.update({
        where: { id: agentId },
        data: {
            name: changes.name,
            recoNumber: changes.recoNumber,
            phone: changes.phone,
            brokerageId: changes.brokerageId
        },
        select: profileSelect
    })

    return toProfile(record)
}
