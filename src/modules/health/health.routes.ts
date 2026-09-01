import express from 'express'

import { getHealth } from '@/modules/health/health.controller'

const router = express.Router()

// Async: a rejected promise must reach Express' error handling rather than
// leaving the probe hanging until it times out.
router.get('/', (req, res, next) => {
    getHealth(req, res).catch(next)
})

export default router
