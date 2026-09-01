import express from 'express'

import { getTransactions, postTransaction } from '@/modules/transaction/transaction.controller'

/**
 * Mounted at `/api/transactions`, behind the session guard — so every handler
 * scopes to `req.agent` and none of them takes an agent id from the caller.
 *
 * Async handlers are wrapped so a rejected promise reaches Express' error
 * handling instead of hanging the request.
 */
const transactionRoutes = express.Router()

transactionRoutes.get('/', (req, res, next) => {
    getTransactions(req, res).catch(next)
})

transactionRoutes.post('/', (req, res, next) => {
    postTransaction(req, res).catch(next)
})

export default transactionRoutes
