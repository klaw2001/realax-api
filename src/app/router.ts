import express from 'express'

import authMiddleware from '@/app/middlewares/authMiddleware'

import authRoutes from '@/app/modules/auth/authRoutes'
import homeRoutes from '@/app/modules/home/homeRoutes'
import masterRoutes from '@/app/modules/master/masterRoutes'
import userRoutes from '@/app/modules/user/userRoutes'
import roleRoutes from '@/app/modules/role/roleRoutes'
import readAccessMiddleware from '@/app/middlewares/readAccessMiddleware'

const router = express.Router()

router.use('/auth', authRoutes)

router.use(authMiddleware)

router.use('/home', homeRoutes)
router.use('/master', masterRoutes)

router.use('/user', readAccessMiddleware('user'), userRoutes)
router.use('/role', readAccessMiddleware('role'), roleRoutes)

export default router
