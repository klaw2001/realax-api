import type { Request, Response } from 'express'

import { toAgentResponse, verifyCredentials } from '@/modules/auth/auth.service'
import { loginRequestSchema, logoutResponseSchema, sessionResponseSchema } from '@/schemas/agent'
import type { ErrorResponse } from '@/schemas/common'

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

/** Promisified `req.session.regenerate` — express-session is callback-only. */
const regenerateSession = (req: Request) =>
    new Promise<void>((resolve, reject) => {
        req.session.regenerate(error => (error ? reject(error) : resolve()))
    })

/** Promisified `req.session.save`, so the 200 is not sent before the store write. */
const saveSession = (req: Request) =>
    new Promise<void>((resolve, reject) => {
        req.session.save(error => (error ? reject(error) : resolve()))
    })

export const login = async (req: Request, res: Response) => {
    const parsed = loginRequestSchema.safeParse(req.body)

    if (!parsed.success) {
        const body: ErrorResponse = {
            error: 'invalid_request',
            message: 'Email and password are required'
        }

        res.status(400).json(body)

        return
    }

    const agent = await verifyCredentials(parsed.data.email, parsed.data.password)

    if (!agent) {
        // One message for every failure. Distinguishing "no such agent" from
        // "wrong password" hands an attacker a list of registered emails.
        const body: ErrorResponse = {
            error: 'invalid_credentials',
            message: 'Email or password is incorrect'
        }

        res.status(401).json(body)

        return
    }

    // New session id on privilege change — a fixed id set before login would
    // otherwise still be valid after it.
    await regenerateSession(req)

    req.session.agentId = agent.id

    await saveSession(req)

    res.status(200).json(sessionResponseSchema.parse({ agent: toAgentResponse(agent) }))
}

export const logout = async (req: Request, res: Response) => {
    await new Promise<void>((resolve, reject) => {
        req.session.destroy(error => (error ? reject(error) : resolve()))
    })

    // Clear the cookie too, so the browser stops presenting an id that no
    // longer resolves to anything.
    res.clearCookie('realax.sid')

    res.status(200).json(logoutResponseSchema.parse({ loggedOut: true }))
}

/**
 * `GET /api/me`. Sits behind `requireAgent`, which is what makes `req.agent`
 * present; the guard below is for the type, not for a reachable state.
 */
export const getMe = (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    res.status(200).json(sessionResponseSchema.parse({ agent: toAgentResponse(req.agent) }))
}
