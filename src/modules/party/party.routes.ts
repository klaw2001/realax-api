import express from 'express'

import {
    deleteParty,
    getParties,
    getParty,
    patchParty,
    postParty
} from '@/modules/party/party.controller'

/**
 * The parties on one transaction, mounted at `/api/transactions/:id/parties`.
 *
 * `mergeParams` so `:id` from the mount point reaches these handlers — every one
 * of them scopes the lookup to `req.agent`, so the id in the path selects a
 * transaction rather than granting access to it.
 *
 * There is no unscoped `/api/parties` collection, and that is deliberate: a
 * person only exists here in the context of a deal, and a route that listed
 * people on their own would be a route that could return a client's date of
 * birth without naming the transaction it belongs to.
 *
 * Async handlers are wrapped so a rejected promise reaches Express' error
 * handling instead of hanging the request.
 */
export const transactionPartyRoutes = express.Router({ mergeParams: true })

transactionPartyRoutes.get('/', (req, res, next) => {
    getParties(req, res).catch(next)
})

transactionPartyRoutes.post('/', (req, res, next) => {
    postParty(req, res).catch(next)
})

transactionPartyRoutes.get('/:partyId', (req, res, next) => {
    getParty(req, res).catch(next)
})

transactionPartyRoutes.patch('/:partyId', (req, res, next) => {
    patchParty(req, res).catch(next)
})

transactionPartyRoutes.delete('/:partyId', (req, res, next) => {
    deleteParty(req, res).catch(next)
})
