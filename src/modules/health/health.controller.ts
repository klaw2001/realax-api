import type { Request, Response } from 'express'

import { healthResponseSchema, type HealthResponse } from '@/schemas/health'

/**
 * The response is parsed through the same schema that generates `openapi.json`,
 * so a handler that drifts from the published contract fails here rather than
 * in the frontend's build.
 */
export const getHealth = (_req: Request, res: Response) => {
    const body: HealthResponse = {
        status: 'ok',
        service: 'realax-api',
        uptimeSeconds: Number(process.uptime().toFixed(2)),
        timestamp: new Date().toISOString()
    }

    res.status(200).json(healthResponseSchema.parse(body))
}
