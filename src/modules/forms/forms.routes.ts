import express from 'express'

import {
    getCompliance,
    getDownload,
    getForm,
    postFill
} from '@/modules/forms/forms.controller'

/**
 * The forms on one transaction, mounted at
 * `/api/transactions/:id/forms` — below the session guard in `app.ts`, so
 * `requireAgent` has already run by the time any of these is reached.
 *
 * `mergeParams` so `:id` from the mount point arrives alongside `:formCode`.
 * Every handler scopes its lookup to `req.agent`: the ids in the path select a
 * transaction and a form, they do not grant access to either.
 */
export const transactionFormRoutes = express.Router({ mergeParams: true })

transactionFormRoutes.get('/:formCode', (req, res, next) => {
    getForm(req, res).catch(next)
})

// The gate runs inside this handler, first, and a failure returns 422 without
// drawing anything. There is deliberately no route, flag or parameter that
// fills a form without passing it.
transactionFormRoutes.post('/:formCode/fill', (req, res, next) => {
    postFill(req, res).catch(next)
})

transactionFormRoutes.get('/:formCode/download', (req, res, next) => {
    getDownload(req, res).catch(next)
})

transactionFormRoutes.get('/:formCode/compliance', (req, res, next) => {
    getCompliance(req, res).catch(next)
})

export default transactionFormRoutes
