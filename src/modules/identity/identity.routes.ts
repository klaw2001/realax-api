import express from 'express'

import { getIdentityRecords, postIdentityScan } from '@/modules/identity/identity.controller'

/**
 * A party's identity documents, mounted at
 * `/api/transactions/:id/parties/:partyId/identity` — below the session guard,
 * so it is protected by where it sits.
 *
 * A router of its own rather than two more handlers on the parties router: this
 * is FINTRAC material with its own retention, its own encryption and its own
 * rules about what may be returned, and the module boundary is what keeps those
 * rules in one place.
 */
export const partyIdentityRoutes = express.Router({ mergeParams: true })

partyIdentityRoutes.get('/', (req, res, next) => {
    getIdentityRecords(req, res).catch(next)
})

partyIdentityRoutes.post('/', (req, res, next) => {
    postIdentityScan(req, res).catch(next)
})

export default partyIdentityRoutes
