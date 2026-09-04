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
    inviteResponseSchema,
    userSchema,
    apiErrorSchema,
    authErrorSchema
} from '@/integrations/signnow/schema'
import {
    SignNowError,
    type EnvelopeSigner,
    type FieldPlacement,
    type PreparedDocument,
    type SentInvite,
    type SignNowProvider
} from '@/integrations/signnow/provider'

/** How long any one upstream call may take before we give up on it. */
const REQUEST_TIMEOUT_MS = 10_000

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
        return new SignNowError('rejected', `signNow refused the request: ${api.data.errors[0]?.message ?? 'no reason given'}`, status)
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
    verifyWebhookSignature
}
