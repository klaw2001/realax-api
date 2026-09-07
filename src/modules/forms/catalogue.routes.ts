import express from 'express'

import { getForms } from '@/modules/forms/catalogue.controller'

/**
 * The form library, mounted at `/api/forms` — below the session guard in
 * `app.ts`, so `requireAgent` has already run.
 *
 * Not under `/api/transactions/:id` because it is not about a transaction. The
 * per-transaction questions — is it filled, may it be filled — each have their
 * own endpoint under that path already.
 */
export const formCatalogueRoutes = express.Router()

formCatalogueRoutes.get('/', (req, res, next) => {
    getForms(req, res).catch(next)
})

export default formCatalogueRoutes
