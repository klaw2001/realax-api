import express from 'express'

import { getBrokerages, getProfile, patchProfile } from '@/modules/agent/agent.controller'

/**
 * Mounted at `/api/agent`, behind the session guard — so every handler here can
 * rely on `req.agent`, and none of them takes an agent id from the caller.
 *
 * The brokerage presets live under this prefix rather than at `/api/brokerages`
 * because they exist for the profile form and nothing else. If brokerages ever
 * become a resource in their own right, that is the point to move them.
 *
 * Async handlers are wrapped so a rejected promise reaches Express' error
 * handling instead of hanging the request.
 */
const agentRoutes = express.Router()

agentRoutes.get('/brokerages', (req, res, next) => {
    getBrokerages(req, res).catch(next)
})

agentRoutes.get('/profile', (req, res, next) => {
    getProfile(req, res).catch(next)
})

agentRoutes.patch('/profile', (req, res, next) => {
    patchProfile(req, res).catch(next)
})

export default agentRoutes
