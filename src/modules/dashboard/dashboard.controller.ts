import type { Request, Response } from 'express'

import { loadDashboard } from '@/modules/dashboard/dashboard.service'
import type { ErrorResponse } from '@/schemas/common'
import { dashboardResponseSchema } from '@/schemas/dashboard'

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

/**
 * `GET /api/me/dashboard`.
 *
 * `me` rather than an agent id in the path: there is no dashboard for anybody
 * but the caller, and a route shaped `/api/agents/:id/dashboard` would invite
 * the question of who may read it.
 */
export const getDashboard = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const dashboard = await loadDashboard(req.agent.id)

    res.status(200).json(dashboardResponseSchema.parse(dashboard))
}
