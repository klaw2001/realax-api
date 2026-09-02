import type { Request, Response } from 'express'

import { checkCompliance, runComplianceGate } from '@/modules/compliance/compliance.service'
import { loadEntryInput } from '@/modules/entries/entries.service'
import {
    FormTemplateNotSeededError,
    TransactionNotFoundError,
    fillTransactionForm
} from '@/modules/forms/fill.service'
import { FormNotFilledError, getFormDownload, getTransactionForm } from '@/modules/forms/forms.service'
import { TemplateNotFoundError } from '@/modules/forms/template.service'
import type { ErrorResponse } from '@/schemas/common'
import { complianceResultSchema } from '@/schemas/compliance'
import {
    fillFormResponseSchema,
    formDownloadResponseSchema,
    transactionFormResponseSchema
} from '@/schemas/form'

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

const transactionNotFound: ErrorResponse = {
    error: 'transaction_not_found',
    message: 'No such transaction'
}

/**
 * The four not-found shapes, kept apart because the remedies differ: the
 * transaction is not yours, the form has no curated template, the template is
 * not seeded into the database, or nothing has been filled yet. Only the last
 * two are things an agent can act on, and the message says which.
 */
const sendNotFound = (error: unknown, res: Response): boolean => {
    if (error instanceof TransactionNotFoundError) {
        res.status(404).json(transactionNotFound)

        return true
    }

    if (error instanceof TemplateNotFoundError) {
        res.status(404).json({
            error: 'form_not_available',
            message: 'That form is not one this service can fill yet'
        } satisfies ErrorResponse)

        return true
    }

    if (error instanceof FormTemplateNotSeededError) {
        res.status(404).json({
            error: 'form_library_not_seeded',
            message: 'The form library has not been loaded on this server'
        } satisfies ErrorResponse)

        return true
    }

    if (error instanceof FormNotFilledError) {
        res.status(404).json({
            error: 'form_not_filled',
            message: 'This form has not been filled yet'
        } satisfies ErrorResponse)

        return true
    }

    return false
}

const params = (req: Request) => ({
    transactionId: req.params.id ?? '',
    formCode: req.params.formCode ?? ''
})

/**
 * `POST /api/transactions/:id/forms/:formCode/fill`.
 *
 * The gate runs first and the fill only happens if it passed. Not "the fill
 * runs and we mark it non-compliant": a partial PDF is a document, and a
 * document that exists is one somebody can send. So a failed check returns 422
 * with the list and nothing is drawn, nothing is stored, and the form's status
 * does not move.
 *
 * There is no override, no force flag and no query parameter that skips this.
 * That is the policy, and the absence of a way around it is the feature.
 */
export const postFill = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const { transactionId, formCode } = params(req)

    try {
        const compliance = await runComplianceGate(transactionId, req.agent.id, formCode)

        if (!compliance.passed) {
            const count = compliance.failures.length

            // 422 rather than 400: the request is well-formed and the agent is
            // allowed to make it. What is not ready is the transaction.
            res.status(422).json({
                error: 'compliance_failed',
                message:
                    count === 1
                        ? 'One thing needs attention before this form can be filled'
                        : `${count} things need attention before this form can be filled`,
                compliance: complianceResultSchema.parse(compliance)
            })

            return
        }

        const entries = await loadEntryInput(transactionId, req.agent.id)
        const result = await fillTransactionForm(transactionId, req.agent.id, formCode, entries)
        const form = await getTransactionForm(transactionId, req.agent.id, formCode)

        res.status(200).json(fillFormResponseSchema.parse({ form, truncated: result.truncated }))
    } catch (error) {
        if (sendNotFound(error, res)) {
            return
        }

        throw error
    }
}

/** `GET /api/transactions/:id/forms/:formCode`. */
export const getForm = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const { transactionId, formCode } = params(req)

    try {
        const form = await getTransactionForm(transactionId, req.agent.id, formCode)

        res.status(200).json(transactionFormResponseSchema.parse({ form }))
    } catch (error) {
        if (sendNotFound(error, res)) {
            return
        }

        throw error
    }
}

/** `GET /api/transactions/:id/forms/:formCode/download`. */
export const getDownload = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const { transactionId, formCode } = params(req)

    try {
        const download = await getFormDownload(transactionId, req.agent.id, formCode)

        res.status(200).json(formDownloadResponseSchema.parse(download))
    } catch (error) {
        if (sendNotFound(error, res)) {
            return
        }

        throw error
    }
}

/**
 * `GET /api/transactions/:id/forms/:formCode/compliance`.
 *
 * The same verdict the fill gates on, without filling and without recording a
 * check. This is what a page reads while an agent is still working; a
 * `ComplianceCheck` row per glance would bury the ones that actually blocked
 * something.
 */
export const getCompliance = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    const { transactionId, formCode } = params(req)

    try {
        const compliance = await checkCompliance(transactionId, req.agent.id, formCode)

        res.status(200).json({ compliance: complianceResultSchema.parse(compliance) })
    } catch (error) {
        if (sendNotFound(error, res)) {
            return
        }

        throw error
    }
}
