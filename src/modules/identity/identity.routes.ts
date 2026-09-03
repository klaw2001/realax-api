import express from 'express'

import { env } from '@/config/env'
import {
    getIdentityRecords,
    postDemoIdentityVerification,
    postIdentityScan,
    postIdentityScanConfirmation,
    postUnassignedIdentityScan
} from '@/modules/identity/identity.controller'

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

// Demo builds only, and mounted rather than gated inside the handler so that
// on an ordinary build the route does not exist at all: no handler to reach, no
// flag to read wrong, and a 404 from the router itself. The service checks the
// same flag again — see `demoVerifyParty` — because a verification nobody
// performed should take two independent mistakes to write, not one.
if (env.DEMO_MODE) {
    partyIdentityRoutes.post('/demo-verify', (req, res, next) => {
        postDemoIdentityVerification(req, res).catch(next)
    })
}

// Confirming is a POST to the reading rather than a PUT on the record: it
// creates the record, and it is the agent's assertion about one photograph
// rather than an edit of anything that already exists.
partyIdentityRoutes.post('/scans/:scanId/confirm', (req, res, next) => {
    postIdentityScanConfirmation(req, res).catch(next)
})

/**
 * Readings taken before there is a party, mounted at
 * `/api/transactions/:id/identity` — the same module, one level up, because a
 * scan with nobody attached to it is not addressable through a party.
 */
export const transactionIdentityRoutes = express.Router({ mergeParams: true })

transactionIdentityRoutes.post('/scans', (req, res, next) => {
    postUnassignedIdentityScan(req, res).catch(next)
})

export default partyIdentityRoutes
