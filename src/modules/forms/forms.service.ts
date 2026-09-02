import prisma from '@/lib/prisma'
import { getSignedUrl, headObject } from '@/lib/s3'
import { TransactionNotFoundError } from '@/modules/forms/fill.service'
import { loadTemplate } from '@/modules/forms/template.service'
import type { FormDownloadResponse, TransactionForm } from '@/schemas/form'

/**
 * Reading a form's state on a transaction (build plan 2.3).
 *
 * The filling itself is `fill.service.ts` and the deciding is
 * `compliance.service.ts`. This is the small remainder the endpoints need: what
 * state is this form in, and how does an agent get a copy of it.
 */

/** Presigned links last minutes. A leaked one should already be dead. */
const DOWNLOAD_TTL_SECONDS = 300

export class FormNotFilledError extends Error {
    constructor(formCode: string) {
        super(`Form ${formCode} has not been filled for this transaction`)
        this.name = 'FormNotFilledError'
    }
}

const ownedTransaction = (transactionId: string, agentId: string) =>
    prisma.transaction.findFirst({
        where: { id: transactionId, agentId },
        select: { id: true }
    })

/**
 * The form's state on a transaction the caller owns.
 *
 * A form nobody has filled yet is `DRAFT` and not available, rather than a 404.
 * The form exists for the transaction as soon as a curated template does — it
 * has simply not been drawn — and a page that had to tell "no row" apart from
 * "row not filled" would have two empty states.
 *
 * `filledCount` is counted from the merged object stored beside the key rather
 * than kept as a counter, so it describes the fill that produced the PDF
 * sitting in the bucket and cannot drift from it.
 */
export const getTransactionForm = async (
    transactionId: string,
    agentId: string,
    formCode: string
): Promise<TransactionForm> => {
    const transaction = await ownedTransaction(transactionId, agentId)

    if (!transaction) {
        throw new TransactionNotFoundError()
    }

    // Throws TemplateNotFoundError for a form with no curated template — a
    // form with geometry and no names is not fillable, deliberately.
    const template = await loadTemplate(formCode)

    const row = await prisma.transactionForm.findFirst({
        where: {
            transactionId,
            formTemplate: { formCode: template.form, revision: template.revision }
        },
        select: { status: true, filledS3Key: true, values: true }
    })

    if (!row) {
        return {
            formCode: template.form,
            revision: template.revision,
            status: 'DRAFT',
            available: false,
            filledCount: 0
        }
    }

    const values = (row.values ?? {}) as Record<string, unknown>
    const names = new Set(template.blanks.filter(blank => blank.kind === 'data').map(b => b.name))

    return {
        formCode: template.form,
        revision: template.revision,
        status: row.status,
        available: row.filledS3Key !== null,
        filledCount: Object.keys(values).filter(key => names.has(key)).length
    }
}

/**
 * A short-lived link to the filled PDF.
 *
 * The object is confirmed to be there before a URL is issued. A presigned URL
 * for a key that does not exist is a perfectly valid URL that 404s when
 * followed, which reaches the agent as a broken download rather than as the
 * thing that is actually wrong.
 */
export const getFormDownload = async (
    transactionId: string,
    agentId: string,
    formCode: string
): Promise<FormDownloadResponse> => {
    const transaction = await ownedTransaction(transactionId, agentId)

    if (!transaction) {
        throw new TransactionNotFoundError()
    }

    const template = await loadTemplate(formCode)

    const row = await prisma.transactionForm.findFirst({
        where: {
            transactionId,
            formTemplate: { formCode: template.form, revision: template.revision }
        },
        select: { filledS3Key: true }
    })

    if (!row?.filledS3Key) {
        throw new FormNotFilledError(template.form)
    }

    if ((await headObject(row.filledS3Key)) === null) {
        throw new FormNotFilledError(template.form)
    }

    return {
        url: await getSignedUrl(row.filledS3Key, DOWNLOAD_TTL_SECONDS),
        expiresInSeconds: DOWNLOAD_TTL_SECONDS,
        // No address, no party name, no transaction id. A file that lands in a
        // downloads folder should not be the thing that names a client.
        fileName: `OREA-${template.form}-filled.pdf`
    }
}
