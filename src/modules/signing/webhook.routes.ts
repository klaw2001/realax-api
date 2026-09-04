import express from 'express'

import { postWebhook } from '@/modules/signing/webhook.controller'

/**
 * The signNow callback endpoint, mounted at `/webhooks/signnow` in `app.ts` —
 * beside `/health` and **above** the session guard.
 *
 * Not under `/api`, deliberately: everything there requires a session, and a
 * vendor calling in has none. It is also not part of `openapi.json`, because
 * the frontend is not a caller and generating a client type for it would
 * suggest otherwise.
 *
 * `.catch(next)` sends an unexpected throw to `errorHandler` and so to a 500,
 * which signNow retries. That is the intended behaviour for a transient fault
 * — see the note in `webhook.controller.ts` about why expected failures answer
 * 200 instead.
 */
export const signingWebhookRoutes = express.Router()

signingWebhookRoutes.post('/', (req, res, next) => {
    postWebhook(req, res).catch(next)
})

export default signingWebhookRoutes
