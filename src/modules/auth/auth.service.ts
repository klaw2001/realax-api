import bcrypt from 'bcryptjs'

import prisma from '@/lib/prisma'
import type { Agent as AgentResponse } from '@/schemas/agent'

/**
 * Cost factor for new hashes. 12 is roughly 250ms on the current dev hardware —
 * slow enough to matter for an offline attack, fast enough for a login form.
 */
const BCRYPT_ROUNDS = 12

/**
 * A real bcrypt digest of a value nothing can log in with. Used to spend the
 * same time verifying a password for an unknown email as for a known one, so
 * response timing does not disclose which agent emails exist.
 */
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO.ZQvJHFm9Q1w3vJp3Q9J0kQ9y1Zzq5S'

/**
 * The agent columns the API is allowed to return. `passwordHash` is absent by
 * construction rather than deleted afterwards.
 */
export const agentSelect = {
    id: true,
    email: true,
    name: true,
    recoNumber: true,
    phone: true,
    brokerageId: true,
    createdAt: true
} as const

export type AgentRecord = {
    id: string
    email: string
    name: string
    recoNumber: string | null
    phone: string | null
    brokerageId: string | null
    createdAt: Date
}

/** Prisma row → the shape published in `openapi.json`. */
export const toAgentResponse = (agent: AgentRecord): AgentResponse => ({
    ...agent,
    createdAt: agent.createdAt.toISOString()
})

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS)

/**
 * Verify credentials.
 *
 * Returns `null` for every failure mode — unknown email, no password set,
 * wrong password — so a caller cannot accidentally turn the distinction into a
 * message that tells an attacker which emails are registered.
 */
export const verifyCredentials = async (email: string, password: string): Promise<AgentRecord | null> => {
    const agent = await prisma.agent.findUnique({
        where: { email: email.trim().toLowerCase() },
        select: { ...agentSelect, passwordHash: true }
    })

    const matches = await bcrypt.compare(password, agent?.passwordHash ?? DUMMY_HASH)

    if (!agent || !agent.passwordHash || !matches) {
        return null
    }

    const { passwordHash: _passwordHash, ...safe } = agent

    return safe
}

/**
 * Load the agent a live session points at. A session outliving its agent row
 * (deleted account, restored database) resolves to `null`, which the middleware
 * turns into a 401 and a destroyed session.
 */
export const findAgentById = (id: string): Promise<AgentRecord | null> =>
    prisma.agent.findUnique({ where: { id }, select: agentSelect })
