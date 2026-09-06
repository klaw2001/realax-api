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

    /**
     * Embedded envelopes only — the email invite returns no ids to store.
     *
     * What a signing link is minted against, and what a webhook's `invite_id`
     * matches. Kept here rather than exposed, exactly as `externalRoleId` is:
     * it is a vendor identifier, and handing it to a browser would be handing
     * out the one thing a link request is addressed by.
     */
    externalInviteId?: string
}

const storedSigners = (value: Prisma.JsonValue): StoredSigner[] =>
    Array.isArray(value) ? (value as unknown as StoredSigner[]) : []

/**
 * Whose turn it is, from the events we have been told about.
 *
 * Pure, and deliberately not authoritative. The vendor decides whether a signer
 * may sign, and the link endpoint asks it — this is for rendering, so a screen
 * can say "waiting on Margaret" and enable one button instead of two.
 *
 * Counting signatures rather than matching `invite_id` to a signer: the count
 * is right whether or not the events carry an id, and on the email path they
 * are the only correlation available at all. It relies on signing being
 * sequential, which is the same assumption the whole feature rests on and which
 * the vendor enforces.
 *
 * `null` once everyone has signed, or when there are no signers to wait on.
 */
export const awaitingSigner = (
    signers: StoredSigner[],
    events: { eventType: string }[]
): StoredSigner | null => {
    const signed = events.filter(event => event.eventType === SIGNED_EVENT).length
    const ordered = [...signers].sort((a, b) => a.order - b.order)

    return ordered[signed] ?? null
}

const toView = (
    record: {
        id: string
        transactionId: string
        provider: string
        status: string
        delivery: string
        signers: Prisma.JsonValue
        events?: { eventType: string }[]
        createdAt: Date
        updatedAt: Date
    },
    formCode: string
): SigningEnvelopeView => {
    const signers = storedSigners(record.signers)

    return {
        id: record.id,
        transactionId: record.transactionId,
        formCode,
        provider: record.provider,
        status: record.status as SigningEnvelopeView['status'],
        delivery: record.delivery as SigningEnvelopeView['delivery'],
        signers: signers.map(signer => ({
            transactionPartyId: signer.transactionPartyId,
            role: signer.role,
            order: signer.order
        })),

        // Null on a finished envelope, and on one read without its events —
        // "nobody is being waited on" is the truthful answer to both.
        awaitingTransactionPartyId: TERMINAL.has(record.status)
            ? null
            : (awaitingSigner(signers, record.events ?? [])?.transactionPartyId ?? null),
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
        include: {
            transactionForm: { include: { formTemplate: { select: { formCode: true } } } },

            // Only the type. The payload is a whole vendor callback and nothing
            // here reads it — `awaitingSigner` counts signatures, and pulling
            // the bodies would mean loading every webhook we have ever received
            // to answer a question about whose turn it is.
            events: { select: { eventType: true } }
        }
    })

    return records.map(record => toView(record, record.transactionForm?.formTemplate.formCode ?? ''))
}

/**
 * How far along an envelope is, for deciding whether an event moves it.
 *
 * signNow retries a failed delivery five times ten seconds apart and then five
 * more four hours apart, so events arriving out of order is not hypothetical: a
 * `fieldinvite.sent` that failed twice can land after the document is already
 * complete. Comparing rank means a late event is recorded and ignored rather
 * than walking the envelope backwards.
 */
const STATUS_RANK: Record<string, number> = {
    created: 0,
    sent: 1,
    signed: 2,
    completed: 3
}

/** Terminal states, which are reachable from anywhere and go no further. */
const TERMINAL = new Set(['declined', 'expired'])

/**
 * What each subscribed event means for the envelope.
 *
 * `fieldinvite.signed` is one signer finishing, not the document — with
 * sequential signing the vendor invites the next one itself, and only
 * `document.complete` means every required field is filled.
 */
/**
 * One signer finishing — the event `awaitingSigner` counts.
 *
 * Named rather than repeated because it is load-bearing in two unrelated
 * places: it moves the envelope's status, and it is how a screen works out
 * whose turn it is.
 */
export const SIGNED_EVENT = 'user.document.fieldinvite.signed'

const STATUS_FOR_EVENT: Record<string, string> = {
    'user.document.fieldinvite.sent': 'sent',
    [SIGNED_EVENT]: 'signed',
    'user.document.complete': 'completed',
    'user.document.fieldinvite.decline': 'declined',
    'user.invite.expired': 'expired'
}

export type WebhookOutcome = 'recorded' | 'replayed' | 'unknown_document' | 'ignored'

/**
 * Record a verified webhook, once.
 *
 * Idempotency is the unique index on `dedupeKey`, not a `findFirst` before
 * inserting: two concurrent redeliveries would both pass a read. The insert
 * either lands or loses, and losing is a normal outcome rather than an error.
 *
 * The status only moves on a first-time insert, and only forwards. A terminal
 * event also clears `activeFormId`, which releases the form so the agent can
 * send a fresh envelope after a decline.
 *
 * `Transaction.status` is deliberately untouched. Moving it to COMPLETED is
 * 3.4's acceptance criterion, along with storing the signed PDF and the audit
 * certificate — doing it here would mark a transaction closed with neither.
 */
export const recordSignerEvent = async (
    externalId: string,
    eventType: string,
    payload: unknown,
    dedupeKey: string
): Promise<WebhookOutcome> => {
    const envelope = await prisma.signingEnvelope.findUnique({ where: { externalId } })

    if (envelope === null) {
        return 'unknown_document'
    }

    try {
        await prisma.signerEvent.create({
            data: {
                envelopeId: envelope.id,
                eventType,
                payload: payload as Prisma.InputJsonValue,
                dedupeKey
            }
        })
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return 'replayed'
        }

        // A real database fault. Thrown, so the route answers 500 and signNow
        // retries — which is the one case where a retry is what we want.
        throw error
    }

    const next = STATUS_FOR_EVENT[eventType]

    if (next === undefined) {
        // Subscribed to something we do not act on, or a new event type. The
        // row is kept; the envelope does not move.
        return 'recorded'
    }

    if (TERMINAL.has(next)) {
        await prisma.signingEnvelope.updateMany({
            where: { id: envelope.id, status: { notIn: [...TERMINAL] } },
            // Clearing activeFormId releases the form for another envelope.
            data: { status: next, activeFormId: null }
        })

        return 'recorded'
    }

    const behind = Object.entries(STATUS_RANK)
        .filter(([, rank]) => rank < (STATUS_RANK[next] ?? 0))
        .map(([status]) => status)

    await prisma.signingEnvelope.updateMany({
        where: { id: envelope.id, status: { in: behind } },
        data: { status: next }
    })

    return 'recorded'
}
