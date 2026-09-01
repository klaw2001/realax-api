import type { NextFunction, Request, Response } from 'express'

import { findAgentById, type AgentRecord } from '@/modules/auth/auth.service'
import type { ErrorResponse } from '@/schemas/common'

declare module 'express-session' {
    interface SessionData {
        /**
         * The only thing the session holds. Everything else about the agent is
         * read from the database on each request, so a profile edit takes
         * effect immediately instead of when the session expires.
         */
        agentId?: string
    }
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /**
             * Set by `requireAgent`. Optional in the type because the property
             * exists on every request object; handlers mounted behind the
             * middleware can rely on it being present.
             */
            agent?: AgentRecord
        }
    }
}

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

/**
 * Session guard. Mounted once, in front of everything under `/api` that is not
 * `/api/auth/*` — an endpoint is protected because of where it is mounted, not
 * because someone remembered to decorate it.
 *
 * Agent accounts only: there are no roles to check and nothing to authorise
 * beyond "is there a live session for an agent that still exists".
 */
export const requireAgent = (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
        const agentId = req.session?.agentId

        if (!agentId) {
            res.status(401).json(unauthorized)

            return
        }

        const agent = await findAgentById(agentId)

        if (!agent) {
            // The session outlived its agent row. Drop it rather than leaving a
            // cookie that 401s forever.
            req.session.destroy(() => {
                res.status(401).json(unauthorized)
            })

            return
        }

        req.agent = agent

        next()
    })().catch(next)
}

export default requireAgent
