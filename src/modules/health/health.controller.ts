import type { Request, Response } from 'express'

import prisma from '@/lib/prisma'
import { ping as pingRedis } from '@/lib/redis'
import { ping as pingS3 } from '@/lib/s3'
import { healthResponseSchema, type DependencyCheck, type HealthResponse } from '@/schemas/health'

/**
 * Run one dependency probe, timing it and never letting it throw.
 *
 * A check that rejects has to read as `down`, not as a 500 from the health
 * endpoint itself — an endpoint that fails when a dependency fails cannot
 * report which dependency failed.
 */
async function check(probe: () => Promise<boolean>): Promise<DependencyCheck> {
    const startedAt = Date.now()

    try {
        const up = await probe()

        return { status: up ? 'up' : 'down', latencyMs: Date.now() - startedAt }
    } catch {
        return { status: 'down', latencyMs: Date.now() - startedAt }
    }
}

/**
 * `GET /health` — the deploy check for Phase 0.5.
 *
 * The response is parsed through the same schema that generates `openapi.json`,
 * so a handler that drifts from the published contract fails here rather than
 * in the frontend's build.
 */
export const getHealth = async (_req: Request, res: Response) => {
    // Run together, not in sequence — three serial round trips would make a
    // slow dependency look like a slow service.
    const [database, redis, storage] = await Promise.all([
        check(async () => {
            await prisma.$queryRaw`SELECT 1`

            return true
        }),
        check(pingRedis),
        check(pingS3)
    ])

    const checks = { database, redis, storage }
    const healthy = Object.values(checks).every(c => c.status === 'up')

    const body: HealthResponse = {
        status: healthy ? 'ok' : 'degraded',
        service: 'realax-api',
        uptimeSeconds: Number(process.uptime().toFixed(2)),
        timestamp: new Date().toISOString(),
        checks
    }

    // 503 rather than 200-with-a-sad-body: an uptime monitor should not have to
    // parse JSON to notice that S3 is unreachable.
    res.status(healthy ? 200 : 503).json(healthResponseSchema.parse(body))
}
