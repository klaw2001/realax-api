/**
 * signNow client.
 *
 * The key lives here and only here (rule 1). Every response is Zod-parsed
 * against schemas built from captured responses; a shape that no longer matches
 * throws rather than returning an envelope with an undefined id in it, because
 * an undefined id is an envelope nobody can ever match a callback to.
 *
 * No retry, matching `repliers/client.ts`: failures are classified and
 * surfaced. signNow does its own retrying in the direction that matters — the
 * webhook deliveries coming back to us.
 */

import { createHmac, timingSafeEqual } from 'crypto'

import { env } from '@/config/env'
import logger from '@/lib/logger'
import {
    documentSchema,
    documentUploadSchema,
    embeddedInviteCreateSchema,
    embeddedInviteLinkSchema,
    inviteResponseSchema,
    userSchema,
    apiErrorSchema,
    authErrorSchema
} from '@/integrations/signnow/schema'
import {
    SignNowError,
    type EmbeddedInvite,
    type EmbeddedLink,
    type EnvelopeSigner,
    type FieldPlacement,
    type PreparedDocument,
    type SentInvite,
    type SignNowProvider
} from '@/integrations/signnow/provider'

/** How long any one upstream call may take before we give up on it. */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * How long a signing link stays usable. signNow counts this in minutes.
 *
 * A constant rather than a parameter: a caller-chosen expiry on a credential
 * that signs a contract is a caller-chosen security property, and there is no
 * caller who needs a different one. Short for the same reason presigned S3
 * links are (`DEFAULT_SIGNED_URL_TTL_SECONDS`) — a leaked link should already be
 * dead — and long enough that a client reading before signing does not run out.
 *
 * Minting again is free, so the recovery from an expiry is a second tap.
 */
const LINK_EXPIRATION_MINUTES = 15

/**
 * The role names placed on a document, derived from our party roles.
 *
 * signNow creates a role per distinct name, so two buyers share the "Buyer"
 * role and are told apart by their invite `order`, not by the role. Kept to the
 * four the domain has; a name signNow has never seen is created on the spot,
 * which is why an unmapped role would silently produce an extra signer.
 */
const roleNameFor = (role: EnvelopeSigner['role']): string => {
    switch (role) {
        case 'BUYER':
            return 'Buyer'
        case 'SELLER':
            return 'Seller'
        case 'SPOUSE':
            return 'Spouse'
        case 'WITNESS':
            return 'Witness'
    }
}

/**
 * Turn a non-2xx body into the right kind of `SignNowError`.
 *
 * The HTTP status is nearly useless here — a revoked key and a malformed
 * request are both 400, and `code: 1537` covers both — so the decision is made
 * on the `error` string, and only when the body is the auth-layer shape.
 * Anything the API layer refuses is `rejected`: it understood us and said no.
 */
const classify = (status: number, body: unknown): SignNowError => {
    const auth = authErrorSchema.safeParse(body)

    if (auth.success) {
        const misconfigured =
            auth.data.error === 'invalid_token' ||
            auth.data.error === 'invalid_client' ||
            auth.data.error === 'access_denied'

        return new SignNowError(
            misconfigured ? 'misconfigured' : 'rejected',
            `signNow refused the request (${auth.data.error})`,
            status
        )
    }

    const api = apiErrorSchema.safeParse(body)

    if (api.success) {
        // The vendor's message names the field, not a client — "Email is
        // invalid", "From must not be empty" — so it is safe to carry and it is
        // the only thing that makes the failure diagnosable.
        // The code is carried as well as the message. Every API-layer refusal is
        // `rejected`, but one of them — 19001028, "not this signer's turn" — is
        // a normal state of a sequential signing run rather than a fault, and
        // the code is the only stable way to recognise it.
        return new SignNowError(
            'rejected',
            `signNow refused the request: ${api.data.errors[0]?.message ?? 'no reason given'}`,
            status,
            api.data.errors[0]?.code
        )
    }

    // 5xx, an HTML error page, a proxy in the way.
    return new SignNowError('unavailable', `signNow answered ${status}`, status)
}

const authorization = (): Record<string, string> => {
    // Non-null: `env.ts` requires the key whenever the provider is `signnow`,
    // and this file is only reachable through that provider.
    return { Authorization: `Bearer ${env.SIGNNOW_API_KEY!}` }
}

/**
 * One authenticated call.
 *
 * Timed out rather than left to hang: this sits behind an agent pressing Send,
 * and an upstream that never answers must not become a request that never
 * returns.
 */
const request = async (
    method: string,
    path: string,
    init: { body?: BodyInit; json?: unknown } = {}
): Promise<unknown> => {
    const url = new URL(path, env.SIGNNOW_BASE_URL)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    let response: Response

    try {
        response = await fetch(url, {
            method,
            headers: {
                ...authorization(),
                Accept: 'application/json',
                ...(init.json === undefined ? {} : { 'Content-Type': 'application/json' })
            },
            body: init.json === undefined ? init.body : JSON.stringify(init.json),
            signal: controller.signal
        })
    } catch (error) {
        // Neither the URL nor the key is in the message.
        throw new SignNowError('unavailable', `signNow request failed: ${(error as Error).message}`)
    } finally {
        clearTimeout(timer)
    }

    const text = await response.text()

    let body: unknown

    try {
        body = text === '' ? {} : JSON.parse(text)
    } catch {
        body = {}
    }

    if (!response.ok) {
        throw classify(response.status, body)
    }

    return body
}

/**
 * Parse a response, or fail loudly.
 *
 * Issue paths only in the log — the values are a client's contract details.
 */
const parse = <T>(schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[] }[] } } }, payload: unknown, what: string): T => {
    const result = schema.safeParse(payload)

    if (!result.success) {
        const paths = [...new Set(result.error.issues.map(issue => issue.path.join('.')))]

        logger.error('signnow response did not match the captured schema', { what, paths })

        throw new SignNowError('schema', `signNow ${what} did not match the expected shape (${paths.join(', ') || 'unknown field'})`)
    }

    return result.data
}

/**
 * Where a signer's boxes go on the page.
 *
 * Our template `bbox` is PDF user space — origin bottom-left, y increasing
 * upward, `[x0, y0, x1, y1]`. signNow measures from the **top-left**, so y is
 * flipped against the page height. Confirmed by placing fields, signing, and
 * looking at the result; the documentation never says. Units are 1:1 — signNow
 * reports our Letter pages as 612×792, the same numbers the template carries —
 * so nothing is scaled.
 *
 * `page_number` is zero-indexed for signNow and one-indexed for us.
 */
const toSignNowField = (placement: FieldPlacement, roleName: string) => {
    const [x0, y0, x1, y1] = placement.bbox

    return {
        name: placement.name,
        page_number: placement.page - 1,
        type: placement.kind === 'signature' ? 'signature' : 'text',
        role: roleName,
        required: true,
        x: Math.round(x0),
        y: Math.round(placement.pageHeight - y1),
        width: Math.round(x1 - x0),
        height: Math.round(y1 - y0)
    }
}

const prepareDocument = async (input: {
    documentName: string
    pdf: Buffer
    signers: EnvelopeSigner[]
    placements: Record<string, FieldPlacement[]>
}): Promise<PreparedDocument> => {
    const fields = input.signers.flatMap(signer =>
        (input.placements[signer.transactionPartyId] ?? []).map(placement =>
            toSignNowField(placement, roleNameFor(signer.role))
        )
    )

    if (fields.length === 0) {
        // signNow accepts a document with no fields, then refuses the invite
        // for it. Failing here names the actual problem.
        throw new SignNowError('rejected', 'No signing fields were placed for any signer')
    }

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(input.pdf)], { type: 'application/pdf' }), `${input.documentName}.pdf`)

    const uploaded = parse(documentUploadSchema, await request('POST', '/document', { body: form }), 'document upload')

    // Fields must be placed while the document is unsent, and this call
    // replaces the whole set rather than appending — so it is one call carrying
    // every signer's boxes, and there is no second chance after the invite.
    await request('PUT', `/document/${uploaded.id}`, { json: { fields } })

    // Roles are created implicitly by the placement above, so their ids are
    // read back rather than assumed.
    const document = parse(documentSchema, await request('GET', `/document/${uploaded.id}`), 'document')

    const roleIds: Record<string, string> = {}

    for (const signer of input.signers) {
        const roleName = roleNameFor(signer.role)
        const role = document.roles.find(candidate => candidate.name === roleName)

        if (role === undefined) {
            throw new SignNowError(
                'schema',
                `signNow did not create a "${roleName}" role for the placed fields`
            )
        }

        roleIds[signer.transactionPartyId] = role.unique_id
    }

    return { externalId: uploaded.id, roleIds }
}

/** The account's own address, which an invite's `from` must be. */
const senderEmail = async (): Promise<string> => {
    const user = parse(userSchema, await request('GET', '/user'), 'user')
    const email = user.primary_email ?? user.emails?.[0]

    if (email === undefined || email === '') {
        throw new SignNowError('schema', 'signNow returned no address for the API account')
    }

    return email
}

const inviteSigners = async (
    externalId: string,
    input: {
        signers: EnvelopeSigner[]
        roleIds: Record<string, string>
        subject: string
        message: string
    }
): Promise<SentInvite> => {
    const from = await senderEmail()

    const body = {
        document_id: externalId,
        from,
        subject: input.subject,
        message: input.message,
        to: input.signers.map(signer => ({
            email: signer.email,
            role: roleNameFor(signer.role),
            role_id: input.roleIds[signer.transactionPartyId],
            // What actually gates sequential signing.
            order: signer.order,
            prefill_signature_name: signer.fullLegalName,
            subject: input.subject,
            message: input.message
        }))
    }

    parse(inviteResponseSchema, await request('POST', `/document/${externalId}/invite`, { json: body }), 'invite')

    return {
        invited: input.signers.map(signer => ({
            transactionPartyId: signer.transactionPartyId,
            order: signer.order
        }))
    }
}

/**
 * Invite everyone without sending anything (build plan 3.2).
 *
 * No `from`, no subject, no message — there is no email, so none of what
 * `inviteSigners` spends a `GET /user` on applies. One call, and it answers with
 * the per-signer ids that make the rest of embedded signing possible.
 *
 * `auth_method: 'none'` because the link itself is the credential and the agent
 * is standing next to the signer. Anything stronger would be a second factor on
 * a person who is physically present, holding the agent's own device.
 */
const inviteSignersEmbedded = async (
    externalId: string,
    input: {
        signers: EnvelopeSigner[]
        roleIds: Record<string, string>
    }
): Promise<EmbeddedInvite> => {
    const body = {
        invites: input.signers.map(signer => ({
            email: signer.email,
            role_id: input.roleIds[signer.transactionPartyId],
            // The same field that sequences the email path, and the vendor
            // enforces it here too: a link for signer 2 is refused until 1 signs.
            order: signer.order,
            auth_method: 'none'
        }))
    }

    const created = parse(
        embeddedInviteCreateSchema,
        await request('POST', `/v2/documents/${externalId}/embedded-invites`, { json: body }),
        'embedded invite'
    )

    // Matched on `order` rather than position. The response is the vendor's
    // list, not an echo of ours, and nothing promises the two are in the same
    // sequence — `order` is the only field common to both that identifies a
    // signer, since the ids are the vendor's and the emails are not returned.
    return {
        invited: input.signers.map(signer => {
            const invite = created.data.find(candidate => candidate.order === signer.order)

            if (invite === undefined) {
                throw new SignNowError(
                    'schema',
                    `signNow created no embedded invite for signing position ${signer.order}`
                )
            }

            return {
                transactionPartyId: signer.transactionPartyId,
                order: signer.order,
                externalInviteId: invite.id
            }
        })
    }
}

const embeddedSigningLink = async (
    externalId: string,
    externalInviteId: string
): Promise<EmbeddedLink> => {
    const link = parse(
        embeddedInviteLinkSchema,
        await request(
            'POST',
            `/v2/documents/${externalId}/embedded-invites/${externalInviteId}/link`,
            { json: { auth_method: 'none', link_expiration: LINK_EXPIRATION_MINUTES } }
        ),
        'embedded signing link'
    )

    return {
        url: link.data.link,
        expiresInSeconds: LINK_EXPIRATION_MINUTES * 60
    }
}

/**
 * Whether a webhook body really came from signNow.
 *
 * `base64(raw sha256 digest)`, verified against real captured callbacks. The
 * length guard before `timingSafeEqual` is not optional: that function *throws*
 * on unequal lengths, and an uncaught throw here becomes a 500 that signNow
 * retries ten times.
 */
export const verifyWebhookSignature = (rawBody: Buffer, header: string | undefined): boolean => {
    const secret = env.SIGNNOW_WEBHOOK_SECRET

    if (secret === undefined || header === undefined || header === '') {
        return false
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest()

    let actual: Buffer

    try {
        actual = Buffer.from(header, 'base64')
    } catch {
        return false
    }

    return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export const signNowHttpProvider: SignNowProvider = {
    name: 'signnow',
    prepareDocument,
    inviteSigners,
    inviteSignersEmbedded,
    embeddedSigningLink,
    verifyWebhookSignature
}
