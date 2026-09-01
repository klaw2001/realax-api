import type { Request, Response } from 'express'

import {
    brokerageExists,
    findProfile,
    listBrokerages,
    updateProfile
} from '@/modules/agent/agent.service'
import {
    agentProfileResponseSchema,
    updateAgentProfileRequestSchema
} from '@/schemas/agent'
import { brokerageListResponseSchema } from '@/schemas/brokerage'
import type { ErrorResponse } from '@/schemas/common'

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

/**
 * `GET /api/agent/brokerages`. The preset table behind the profile form's
 * select. Reference data only — nothing here is agent-specific.
 */
export const getBrokerages = async (_req: Request, res: Response) => {
    const brokerages = await listBrokerages()

    res.status(200).json(brokerageListResponseSchema.parse({ brokerages }))
}

/**
 * `GET /api/agent/profile`. Always the caller's own — the agent id comes from
 * the session, never from the request.
 */
export const getProfile = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const profile = await findProfile(req.agent.id)

    if (!profile) {
        // `requireAgent` loaded this row moments ago, so this is only reachable
        // if the account was deleted mid-request.
        res.status(401).json(unauthorized)

        return
    }

    res.status(200).json(agentProfileResponseSchema.parse({ profile }))
}

/** `PATCH /api/agent/profile`. */
export const patchProfile = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const parsed = updateAgentProfileRequestSchema.safeParse(req.body)

    if (!parsed.success) {
        const body: ErrorResponse = {
            error: 'invalid_request',
            // Field names only. The rejected values are the agent's own
            // details and do not belong in an error body.
            message: `Invalid profile fields: ${[
                ...new Set(parsed.error.issues.map(issue => issue.path.join('.')))
            ].join(', ')}`
        }

        res.status(400).json(body)

        return
    }

    // Checked rather than left to the foreign key, so a bad id is a readable
    // 400 instead of a constraint violation surfacing as a 500.
    if (parsed.data.brokerageId && !(await brokerageExists(parsed.data.brokerageId))) {
        const body: ErrorResponse = {
            error: 'unknown_brokerage',
            message: 'That brokerage does not exist'
        }

        res.status(400).json(body)

        return
    }

    const profile = await updateProfile(req.agent.id, parsed.data)

    res.status(200).json(agentProfileResponseSchema.parse({ profile }))
}
