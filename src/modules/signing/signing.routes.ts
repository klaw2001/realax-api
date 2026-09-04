import express from 'express'

import { getEnvelopes, postEnvelope } from '@/modules/signing/signing.controller'

/**
 * Signing on one transaction, mounted at `/api/transactions/:id/signing` —
 * below the session guard in `app.ts`, so `requireAgent` has already run.
 *
 * `mergeParams` so `:id` from the mount point reaches the handlers.
 *
 * Its own module rather than a `/forms/:formCode/send` bolted into the forms
 * router: an envelope is not a property of a form, it is a thing raised against
 * one, and 3.4 gives it documents and an audit certificate of its own.
 */
export const transactionSigningRoutes = express.Router({ mergeParams: true })

transactionSigningRoutes.post('/', (req, res, next) => {
    postEnvelope(req, res).catch(next)
})

transactionSigningRoutes.get('/', (req, res, next) => {
    getEnvelopes(req, res).catch(next)
})

export default transactionSigningRoutes
