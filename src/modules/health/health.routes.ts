import express from 'express'

import { getHealth } from '@/modules/health/health.controller'

const router = express.Router()

router.get('/', getHealth)

export default router
