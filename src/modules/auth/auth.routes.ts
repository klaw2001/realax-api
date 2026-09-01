import express from 'express'

import { getMe, login, logout } from '@/modules/auth/auth.controller'

/**
 * Public: mounted at `/api/auth`, ahead of the session guard.
 *
 * Async handlers are wrapped so a rejected promise reaches Express' error
 * handling instead of hanging the request.
 */
export const authRoutes = express.Router()

authRoutes.post('/login', (req, res, next) => {
    login(req, res).catch(next)
})

authRoutes.post('/logout', (req, res, next) => {
    logout(req, res).catch(next)
})

/**
 * Protected: mounted at `/api/me`, behind the session guard.
 *
 * It lives here rather than at `/api/auth/me` on purpose — everything under
 * `/api/auth` is exempt from the guard, and `/me` answering without a session
 * is precisely what the frontend route guard must not be able to do.
 */
export const meRoutes = express.Router()

meRoutes.get('/', getMe)
