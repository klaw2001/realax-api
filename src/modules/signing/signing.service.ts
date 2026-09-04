import { Prisma } from '@prisma/client'

import prisma from '@/lib/prisma'
import logger from '@/lib/logger'
import { getObjectBytes } from '@/lib/s3'
import { signNowProvider } from '@/integrations/signnow'
import { type EnvelopeSigner, type SignNowProvider } from '@/integrations/signnow/provider'
import { TransactionNotFoundError } from '@/modules/forms/fill.service'
import { FormNotFilledError } from '@/modules/forms/forms.service'
import { loadTemplate } from '@/modules/forms/template.service'
import { listTransactionParties } from '@/modules/party/party.service'
import { placementsForParties, SignerHasNoLineError } from '@/modules/signing/placement.service'
import { setTransactionStatus } from '@/modules/transaction/transaction.service'
import type { Party } from '@/schemas/party'
import type { SignerValidationFailure, SigningEnvelopeView } from '@/schemas/signing'

/**
 * Raising an envelope on a filled form (build plan 3.1).
 *
 * The compliance gate runs in the controller, as it does for filling. What is
 * here is the part the gate cannot answer: whether the *parties* can be
 * invited, and the ordering that decides what is left behind when a step fails.
 */

export { TransactionNotFoundError, FormNotFilledError }

export class EnvelopeAlreadySentError extends Error {
    constructor(readonly envelopeId: string) {
        super('This form already has an envelope out for signature')
        this.name = 'EnvelopeAlreadySentError'
    }
}

export class SignerValidationError extends Error {
    constructor(readonly failures: SignerValidationFailure[]) {
        super('The parties on this transaction cannot all be invited to sign')
        this.name = 'SignerValidationError'
    }
}

/**
 * Deliberately not a full RFC 5322 implementation.
 *
 * The point is to catch a typo'd address before it becomes an invite that
 * silently never arrives — which is indistinguishable, from the agent's side,
 * from a signer who is ignoring it.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The parties, as signers, or an explanation of why they cannot be.
 *
 * Pure: no database, no vendor. The input is `listTransactionParties` output,
 * already ordered `signingOrder asc nulls last, createdAt asc`.
 *
 * This exists because the compliance gate does not cover it. The gate checks
 * form blanks, and `mapper.service.ts` maps the notice-email blanks from
 * `buyers[0]` and `sellers[0]` only — so a gate-passing Form 100 can still
 * carry a second seller, a spouse or a witness with no email at all. Without
 * this check that becomes a half-invited contract.
 */
export const resolveSigners = (parties: Party[]): EnvelopeSigner[] => {
    const failures: SignerValidationFailure[] = []

    if (parties.length === 0) {
        throw new SignerValidationError([
            {
                transactionPartyId: null,
                role: null,
                field: 'parties',
                message: 'This transaction has no parties to sign'
            }
        ])
    }

    for (const party of parties) {
        if (party.email === null || party.email === '' || !EMAIL_PATTERN.test(party.email)) {
            failures.push({
                transactionPartyId: party.id,
                role: party.role,
                field: 'email',
                // Names what to fix, never the value. Rule 6.
                message:
                    party.email === null || party.email === ''
                        ? 'This party has no email address'
                        : 'This party’s email address is not a valid address'
            })
        }
    }

    const orders = parties.map(party => party.signingOrder)
    const set = orders.filter((order): order is number => order !== null)

    if (set.length !== 0 && set.length !== orders.length) {
        // Nulls first or last? Either guess puts a contract in front of
        // somebody in an order the agent did not choose. One click fixes it.
        failures.push({
            transactionPartyId: null,
            role: null,
            field: 'signingOrder',
            message: 'Some parties have a signing position and some do not. Set all of them, or none.'
        })
    } else if (new Set(set).size !== set.length) {
        // signNow itself permits two recipients to share an order — they are
        // invited at the same time. We refuse it anyway: the build plan says
        // signing is sequential, one signer at a time, and two parties
        // explicitly at position 1 means the agent's intent is genuinely
        // ambiguous rather than parallel-by-design.
        failures.push({
            transactionPartyId: null,
            role: null,
            field: 'signingOrder',
            message: 'Two parties have the same signing position'
        })
    }

    if (failures.length > 0) {
        throw new SignerValidationError(failures)
    }

    // Normalised to a dense 1..n rather than passed through. Sparse orders
    // (1, 5, 9) express the same sequence, and whether the vendor accepts gaps
    // is not a question worth depending on.
    return parties.map((party, index) => ({
        transactionPartyId: party.id,
        email: party.email!,
        fullLegalName: party.fullLegalName,
        order: index + 1,
        role: party.role
    }))
}

/** The stored shape of `SigningEnvelope.signers`. */
interface StoredSigner {
    transactionPartyId: string
    role: Party['role']
    order: number
    externalRoleId: string
}

const toView = (
    record: {
        id: string
        transactionId: string
        provider: string
        status: string
        signers: Prisma.JsonValue
        createdAt: Date
        updatedAt: Date
    },
    formCode: string
): SigningEnvelopeView => {
    const signers = Array.isArray(record.signers) ? (record.signers as unknown as StoredSigner[]) : []

    return {
        id: record.id,
        transactionId: record.transactionId,
        formCode,
        provider: record.provider,
        status: record.status as SigningEnvelopeView['status'],
        signers: signers.map(signer => ({
            transactionPartyId: signer.transactionPartyId,
            role: signer.role,
            order: signer.order
        })),
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString()
    }
}

const ownedTransaction = (transactionId: string, agentId: string) =>
    prisma.transaction.findFirst({ where: { id: transactionId, agentId }, select: { id: true } })

/**
 * Send a filled form for signature.
 *
 * The ordering is the substance of this function, because every step that can
 * fail leaves something behind, and the arrangement decides what:
 *
 *   prepare (upload + place fields)  → a stranded vendor document, nobody emailed
 *   persist the envelope             → nothing; the unique index refuses a double Send
 *   invite                           → an envelope at `created`, which the next Send resumes
 *   mark sent                        → nothing; the webhook moves it anyway
 *
 * The vendor call happens before the row is written, deliberately. Reserving a
 * row first would mean a placeholder `externalId` to overwrite, and a crash
 * between the two would leave a phantom `created` envelope holding the
 * `activeFormId` index against a document that does not exist. The worst case
 * here is a vendor document nobody was invited to.
 *
 * `provider` is an optional last parameter so tests can inject a stub, matching
 * `scanIdentityDocument(..., provider?: OcrProvider)`.
 */
export const createEnvelopeForForm = async (
    transactionId: string,
    agentId: string,
    formCode: string,
    provider: SignNowProvider = signNowProvider()
): Promise<SigningEnvelopeView> => {
    if (!(await ownedTransaction(transactionId, agentId))) {
        throw new TransactionNotFoundError()
    }

    const template = await loadTemplate(formCode)

    const form = await prisma.transactionForm.findFirst({
        where: {
            transactionId,
            formTemplate: { formCode: template.form, revision: template.revision }
        },
        select: { id: true, filledS3Key: true }
    })

    // Never filled on demand. Sending a document the agent has not looked at is
    // not a convenience.
    if (!form?.filledS3Key) {
        throw new FormNotFilledError(template.form)
    }

    const existing = await prisma.signingEnvelope.findUnique({ where: { activeFormId: form.id } })

    if (existing && existing.status !== 'created') {
        throw new EnvelopeAlreadySentError(existing.id)
    }

    const parties = await listTransactionParties(transactionId, agentId)
    const signers = resolveSigners(parties ?? [])

    let placements

    try {
        placements = placementsForParties(template, parties ?? [])
    } catch (error) {
        if (error instanceof SignerHasNoLineError) {
            throw new SignerValidationError([
                {
                    transactionPartyId: error.transactionPartyId,
                    role: error.role,
                    field: 'parties',
                    message: error.message
                }
            ])
        }

        throw error
    }

    // A crash between the last Send and this one left a document at the vendor
    // with fields already placed. Reuse it rather than uploading a second copy
    // — fields cannot be re-placed once a document is sent, and this one never
    // was.
    if (existing) {
        const invited = await provider.inviteSigners(existing.externalId, {
            signers,
            roleIds: Object.fromEntries(
                ((existing.signers as unknown as StoredSigner[]) ?? []).map(signer => [
                    signer.transactionPartyId,
                    signer.externalRoleId
                ])
            ),
            subject: `Please sign OREA Form ${template.form}`,
            message: 'Your agent has sent this document for signature.'
        })

        void invited

        await prisma.signingEnvelope.updateMany({
            where: { id: existing.id, status: 'created' },
            data: { status: 'sent' }
        })

        await setTransactionStatus(
            transactionId,
            ['DRAFT', 'COMPLIANCE_PENDING', 'READY_TO_SIGN'],
            'OUT_FOR_SIGNATURE'
        )

        const resumed = await prisma.signingEnvelope.findUniqueOrThrow({ where: { id: existing.id } })

        return toView(resumed, template.form)
    }

    const pdf = await getObjectBytes(form.filledS3Key)

    const prepared = await provider.prepareDocument({
        // No address, no party name. A document name is a thing a vendor
        // displays in a list and puts in an email subject.
        documentName: `OREA-${template.form}`,
        pdf: Buffer.from(pdf),
        signers,
        placements
    })

    const stored: StoredSigner[] = signers.map(signer => ({
        transactionPartyId: signer.transactionPartyId,
        role: signer.role,
        order: signer.order,
        externalRoleId: prepared.roleIds[signer.transactionPartyId] ?? ''
    }))

    let envelope

    try {
        envelope = await prisma.signingEnvelope.create({
            data: {
                transactionId,
                transactionFormId: form.id,
                activeFormId: form.id,
                externalId: prepared.externalId,
                status: 'created',
                signers: stored as unknown as Prisma.InputJsonValue
            }
        })
    } catch (error) {
        // Two Sends raced and the other one won at the unique index. That is
        // the index doing the job a check-then-act cannot.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            const winner = await prisma.signingEnvelope.findUnique({ where: { activeFormId: form.id } })

            throw new EnvelopeAlreadySentError(winner?.id ?? '')
        }

        // The document exists at the vendor and nobody has been invited to it.
        // Not an error the agent can act on, and not one that reaches a signer.
        logger.error('signnow document orphaned', { externalId: prepared.externalId })

        throw error
    }

    await provider.inviteSigners(prepared.externalId, {
        signers,
        roleIds: prepared.roleIds,
        subject: `Please sign OREA Form ${template.form}`,
        message: 'Your agent has sent this document for signature.'
    })

    // Guarded on `created`, so a `fieldinvite.sent` webhook that has already
    // arrived and moved the row is not walked backwards. Webhooks are the
    // source of truth.
    await prisma.signingEnvelope.updateMany({
        where: { id: envelope.id, status: 'created' },
        data: { status: 'sent' }
    })

    await setTransactionStatus(
        transactionId,
        ['DRAFT', 'COMPLIANCE_PENDING', 'READY_TO_SIGN'],
        'OUT_FOR_SIGNATURE'
    )

    const sent = await prisma.signingEnvelope.findUniqueOrThrow({ where: { id: envelope.id } })

    return toView(sent, template.form)
}

/** Every envelope on a transaction, newest first. `null` when not the caller's. */
export const listEnvelopes = async (
    transactionId: string,
    agentId: string
): Promise<SigningEnvelopeView[] | null> => {
    if (!(await ownedTransaction(transactionId, agentId))) {
        return null
    }

    const records = await prisma.signingEnvelope.findMany({
        where: { transactionId },
        orderBy: { createdAt: 'desc' },
        include: { transactionForm: { include: { formTemplate: { select: { formCode: true } } } } }
    })

    return records.map(record => toView(record, record.transactionForm?.formTemplate.formCode ?? ''))
}
