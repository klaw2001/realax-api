import type { Request, Response } from 'express'

import { SignNowError } from '@/integrations/signnow/provider'
import { runComplianceGate } from '@/modules/compliance/compliance.service'
import { TemplateNotFoundError, TemplateInvalidError } from '@/modules/forms/template.service'
import {
    createEnvelopeForForm,
    listEnvelopes,
    mintSigningLink,
    EnvelopeAlreadySentError,
    EnvelopeClosedError,
    EnvelopeDeliveryMismatchError,
    EnvelopeNotEmbeddedError,
    FormNotFilledError,
    SignerNotOnEnvelopeError,
    SignerNotYetInvitedError,
    SignerValidationError,
    TransactionNotFoundError
} from '@/modules/signing/signing.service'
import { complianceResultSchema } from '@/schemas/compliance'
import type { ErrorResponse } from '@/schemas/common'
import {
    createEnvelopeRequestSchema,
    envelopeListResponseSchema,
    envelopeResponseSchema,
    signingLinkRequestSchema,
    signingLinkResponseSchema
} from '@/schemas/signing'

const unauthorized: ErrorResponse = { error: 'unauthorized', message: 'Authentication required' }

const transactionNotFound: ErrorResponse = {
    error: 'transaction_not_found',
    message: 'No such transaction'
}

const params = (req: Request) => ({ transactionId: req.params.id ?? '' })

/**
 * Map a vendor failure to a status.
 *
 * All 502: the request was fine and the agent did nothing wrong — something
 * outside this service did. `misconfigured` is split from `unavailable` for the
 * same reason the OCR errors are: telling somebody to try again when no retry
 * can ever succeed sends them round a loop with no exit.
 */
const sendProviderError = (error: SignNowError, res: Response): void => {
    const body: Record<SignNowError['kind'], ErrorResponse> = {
        unavailable: {
            error: 'signing_unavailable',
            message: 'The e-signature service could not be reached. Try again in a moment.'
        },
        misconfigured: {
            error: 'signing_misconfigured',
            message: 'The e-signature service rejected our credentials. This needs an administrator.'
        },
        rejected: {
            error: 'signing_rejected',
            message: `The e-signature service refused this document. ${error.message}`
        },
        schema: {
            error: 'signing_rejected',
            message: 'The e-signature service answered in a way we did not expect. This has been reported.'
        }
    }

    res.status(502).json(body[error.kind])
}

/** `POST /api/transactions/:id/signing`. */
export const postEnvelope = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)
        return
    }

    const parsed = createEnvelopeRequestSchema.safeParse(req.body)

    if (!parsed.success) {
        // The field names, not the values.
        const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))]

        res.status(400).json({
            error: 'invalid_request',
            message: `Check these fields: ${fields.join(', ') || 'the request body'}`
        } satisfies ErrorResponse)

        return
    }

    const { transactionId } = params(req)
    const { formCode, delivery } = parsed.data

    try {
        // Before anything else, and recorded. The gate running is itself the
        // audit artifact — the record of why a document was not sent on a
        // particular afternoon.
        const compliance = await runComplianceGate(transactionId, req.agent.id, formCode)

        if (!compliance.passed) {
            const count = compliance.failures.length

            res.status(422).json({
                error: 'compliance_failed',
                message:
                    count === 1
                        ? 'One thing needs attention before this form can be sent for signature'
                        : `${count} things need attention before this form can be sent for signature`,
                compliance: complianceResultSchema.parse(compliance)
            })

            return
        }

        const envelope = await createEnvelopeForForm(transactionId, req.agent.id, formCode, delivery)

        res.status(201).json(envelopeResponseSchema.parse({ envelope }))
    } catch (error) {
        if (error instanceof TransactionNotFoundError) {
            res.status(404).json(transactionNotFound)
            return
        }

        if (error instanceof TemplateNotFoundError || error instanceof TemplateInvalidError) {
            res.status(404).json({
                error: 'form_not_available',
                message: 'That form is not available'
            } satisfies ErrorResponse)
            return
        }

        if (error instanceof FormNotFilledError) {
            res.status(404).json({
                error: 'form_not_filled',
                message: 'Fill this form before sending it for signature'
            } satisfies ErrorResponse)
            return
        }

        if (error instanceof EnvelopeDeliveryMismatchError) {
            res.status(409).json({
                error: 'envelope_delivery_mismatch',
                message:
                    error.delivery === 'embedded'
                        ? 'This form was already started for in-app signing. Open it there rather than emailing it.'
                        : 'This form was already started as an email invite. The signers have been written to.'
            } satisfies ErrorResponse)
            return
        }

        if (error instanceof EnvelopeAlreadySentError) {
            res.status(409).json({
                error: 'envelope_already_sent',
                message: 'This form is already out for signature'
            } satisfies ErrorResponse)
            return
        }

        if (error instanceof SignerValidationError) {
            // A second 422, distinct from the compliance one, because the two
            // are fixed on different pages: this one on the parties list.
            res.status(422).json({
                error: 'signers_incomplete',
                message:
                    error.failures.length === 1
                        ? 'One party cannot be invited to sign yet'
                        : `${error.failures.length} parties cannot be invited to sign yet`,
                signers: error.failures
            })
            return
        }

        if (error instanceof SignNowError) {
            sendProviderError(error, res)
            return
        }

        throw error
    }
}

/** `GET /api/transactions/:id/signing`. */
export const getEnvelopes = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)
        return
    }

    const envelopes = await listEnvelopes(params(req).transactionId, req.agent.id)

    if (envelopes === null) {
        res.status(404).json(transactionNotFound)
        return
    }

    res.status(200).json(envelopeListResponseSchema.parse({ envelopes }))
}

/**
 * `POST /api/transactions/:id/signing/:envelopeId/link`.
 *
 * The only response body in this service that contains a credential. It is sent
 * with `Cache-Control: no-store` — the first response header anywhere in this
 * codebase, and worth the exception: everything else here returns facts about a
 * transaction, and this returns the ability to sign one. A shared or proxied
 * cache holding it for even a moment is a different class of mistake.
 *
 * Nothing about the URL is logged, including on the way out.
 */
export const postSigningLink = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)
        return
    }

    const parsed = signingLinkRequestSchema.safeParse(req.body)

    if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))]

        res.status(400).json({
            error: 'invalid_request',
            message: `Check these fields: ${fields.join(', ') || 'the request body'}`
        } satisfies ErrorResponse)

        return
    }

    try {
        const link = await mintSigningLink(
            params(req).transactionId,
            req.agent.id,
            req.params.envelopeId ?? '',
            parsed.data.transactionPartyId
        )

        res.setHeader('Cache-Control', 'no-store')
        res.status(200).json(signingLinkResponseSchema.parse(link))
    } catch (error) {
        // An envelope on somebody else's transaction is a 404, the same as one
        // that does not exist. A path id selects; it does not grant.
        if (error instanceof TransactionNotFoundError) {
            res.status(404).json({
                error: 'envelope_not_found',
                message: 'No such envelope'
            } satisfies ErrorResponse)
            return
        }

        if (error instanceof SignerNotOnEnvelopeError) {
            res.status(404).json({
                error: 'signer_not_on_envelope',
                message: 'That party is not a signer on this envelope'
            } satisfies ErrorResponse)
            return
        }

        if (error instanceof EnvelopeNotEmbeddedError) {
            res.status(409).json({
                error: 'envelope_not_embedded',
                message: 'This form was emailed to the signers, so there is nothing to open here'
            } satisfies ErrorResponse)
            return
        }

        if (error instanceof EnvelopeClosedError) {
            res.status(409).json({
                error: 'envelope_closed',
                message: `This envelope is ${error.status} — nobody can sign it now`
            } satisfies ErrorResponse)
            return
        }

        if (error instanceof SignerNotYetInvitedError) {
            // 409 rather than 403: nothing is forbidden, it is a queue. The id
            // of whoever is being waited on, never a name — the frontend has
            // the party list and joins on it.
            res.status(409).json({
                error: 'signer_not_yet_invited',
                message: 'The signer before this one has not finished yet'
            } satisfies ErrorResponse)
            return
        }

        if (error instanceof SignNowError) {
            sendProviderError(error, res)
            return
        }

        throw error
    }
}
