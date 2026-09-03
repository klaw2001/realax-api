import express from 'express'

import { getDashboard } from '@/modules/dashboard/dashboard.controller'

/**
 * The caller's own summary, mounted at `/api/me` — below the session guard, so
 * it is protected by where it sits.
 */
const dashboardRoutes = express.Router()

dashboardRoutes.get('/dashboard', (req, res, next) => {
    getDashboard(req, res).catch(next)
})

export default dashboardRoutes
