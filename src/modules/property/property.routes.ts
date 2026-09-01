import express from 'express'

import {
    getProperty,
    getPropertyByMls,
    getPropertySearch,
    putProperty
} from '@/modules/property/property.controller'

/**
 * MLS lookup, mounted at `/api/properties`. Read-only and not scoped to a
 * transaction: an agent searches before deciding which listing a draft is
 * about.
 */
export const propertyRoutes = express.Router()

propertyRoutes.get('/search', (req, res, next) => {
    getPropertySearch(req, res).catch(next)
})

propertyRoutes.get('/mls/:mlsNumber', (req, res, next) => {
    getPropertyByMls(req, res).catch(next)
})

/**
 * The property on one transaction, mounted at `/api/transactions/:id/property`.
 *
 * `mergeParams` so `:id` from the mount point reaches these handlers — every
 * one of them scopes the lookup to `req.agent`, so the id in the path selects a
 * transaction rather than granting access to it.
 */
export const transactionPropertyRoutes = express.Router({ mergeParams: true })

transactionPropertyRoutes.get('/', (req, res, next) => {
    getProperty(req, res).catch(next)
})

transactionPropertyRoutes.put('/', (req, res, next) => {
    putProperty(req, res).catch(next)
})
