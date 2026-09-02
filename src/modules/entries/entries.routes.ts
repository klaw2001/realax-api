import express from 'express'

import { getEntries, putEntries } from '@/modules/entries/entries.controller'

/**
 * The agreement terms on one transaction, mounted at
 * `/api/transactions/:id/entries`.
 *
 * `mergeParams` so `:id` from the mount point reaches these handlers. Every one
 * of them scopes the lookup to `req.agent`, so the id in the path selects a
 * transaction rather than granting access to it.
 */
export const transactionEntriesRoutes = express.Router({ mergeParams: true })

transactionEntriesRoutes.get('/', (req, res, next) => {
    getEntries(req, res).catch(next)
})

transactionEntriesRoutes.put('/', (req, res, next) => {
    putEntries(req, res).catch(next)
})

export default transactionEntriesRoutes
