import './helpers/signNowMock'

import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import request from 'supertest'

import app from '../src/app'
import logger from '../src/lib/logger'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import s3, { keys } from '../src/lib/s3'
import { mockProvider, __setMockOutcome } from '../src/integrations/signnow/mock.client'
import {
    SignNowError,
    SIGNNOW_NOT_THIS_SIGNERS_TURN,
    type SignNowProvider
} from '../src/integrations/signnow/provider'
import { hashPassword } from '../src/modules/auth/auth.service'
import { createEnvelopeForForm, SignerValidationError } from '../src/modules/signing/signing.service'

// Build plan 3.1, at the boundary. What this suite is about: that the gate and
// the party checks are actually in front of the vendor call, that a form which
// is already out for signature cannot be sent twice however hard the agent
// clicks, and that a failure part-way through leaves something recoverable.

// Every send re-reads the filled PDF out of S3 in ca-central-1, and `beforeAll`
// renders and uploads one first. Against Jest's 5-second default that passes on
// a good connection and fails on a normal one — measured at 2.5–3.8s per test
// with the occasional run over the line, which is the worst kind of failing
// test: one that is right about the code and wrong about the day. The vendor is
// stubbed here; the latency that remains is real and worth waiting for, because
// reading the object back is the step that proves the fill and the send agree
// on where the document lives.
jest.setTimeout(30_000)

const FORM = '100'

const EMAIL = 'signing.envelope.test.agent@realax.test'
const OTHER_EMAIL = 'signing.envelope.test.other@realax.test'
const PASSWORD = 'a-correct-test-password'

let agentId = ''
let otherAgentId = ''
let transactionId = ''
let otherTransactionId = ''
let sellerPartyId = ''

const signIn = async () => {
    const agent = request.agent(app)
    const response = await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })

    expect(response.status).toEqual(200)

    return agent
}

const completeEntries = {
    agreementDate: '2026-09-02',
    purchasePrice: '1225000.00',
    purchasePriceWords: 'One Million Two Hundred Twenty-Five Thousand',
    depositTiming: 'Upon Acceptance',
    depositAmount: '60000.00',
    depositAmountWords: 'Sixty Thousand',
    depositHolder: 'Realax Realty Inc., Brokerage',
    schedulesList: 'A',
    irrevocabilityBoundParty: 'Buyer',
    irrevocabilityTime: '11:59 p.m.',
    irrevocabilityDate: '2026-09-04',
    completionDate: '2026-11-14',
    titleSearchDate: '2026-10-24',
    noticesSellerFax: '416-555-0143',
    noticesBuyerFax: '416-555-0165',
    chattelsIncluded: ['Refrigerator', 'Stove'],
    fixturesExcluded: ['Dining room chandelier'],
    rentalItems: ['Hot water tank'],
    hstTreatment: 'included in',
    propertyPresentUse: 'Single family residential',
    listingBrokerageName: 'Bayview Heights Real Estate Ltd., Brokerage',
    listingBrokerageTel: '416-555-0173',
    listingBrokerageSalesperson: 'Alan Prakash',
    sellerLawyerName: 'Hollis & Wren LLP',
    sellerLawyerAddress: '120 Adelaide Street West, Suite 900, Toronto, ON M5H 1T1',
    sellerLawyerEmail: 'conveyancing@holliswren.example.test',
    sellerLawyerTel: '416-555-0107',
    sellerLawyerFax: '416-555-0108',
    buyerLawyerName: 'Marchetti Law Professional Corporation',
    buyerLawyerAddress: '75 Front Street East, Suite 300, Toronto, ON M5E 1B8',
    buyerLawyerEmail: 'closings@marchettilaw.example.test',
    buyerLawyerTel: '416-555-0131',
    buyerLawyerFax: '416-555-0132'
}

/**
 * A provider that records what it was asked, and can be told to fail.
 *
 * The cast at the bottom means a method missing from here is `undefined` at
 * runtime rather than a compile error, so every method added to
 * `SignNowProvider` has to be added here too.
 */
const stubProvider = (
    over: Partial<SignNowProvider> = {}
): SignNowProvider & {
    prepareCalls: number
    inviteCalls: number
    embeddedInviteCalls: number
    linkCalls: number
} => {
    const stub = {
        name: 'stub',
        prepareCalls: 0,
        inviteCalls: 0,
        embeddedInviteCalls: 0,
        linkCalls: 0,
        async inviteSignersEmbedded(
            _externalId: string,
            input: Parameters<SignNowProvider['inviteSignersEmbedded']>[1]
        ) {
            stub.embeddedInviteCalls += 1

            return {
                invited: input.signers.map(signer => ({
                    transactionPartyId: signer.transactionPartyId,
                    order: signer.order,
                    externalInviteId: `${signer.order}`.repeat(40).slice(0, 40)
                }))
            }
        },
        async embeddedSigningLink(_externalId: string, externalInviteId: string) {
            stub.linkCalls += 1

            return {
                url: `https://mock.invalid/embedded-signing/${externalInviteId}`,
                expiresInSeconds: 900
            }
        },
        async prepareDocument(input: Parameters<SignNowProvider['prepareDocument']>[0]) {
            stub.prepareCalls += 1

            return {
                externalId: 'a'.repeat(40),
                roleIds: Object.fromEntries(
                    input.signers.map(signer => [signer.transactionPartyId, 'b'.repeat(40)])
                )
            }
        },
        async inviteSigners(
            _externalId: string,
            input: Parameters<SignNowProvider['inviteSigners']>[1]
        ) {
            stub.inviteCalls += 1

            return {
                invited: input.signers.map(signer => ({
                    transactionPartyId: signer.transactionPartyId,
                    order: signer.order
                }))
            }
        },
        verifyWebhookSignature: () => true,
        ...over
    }

    return stub as SignNowProvider & {
        prepareCalls: number
        inviteCalls: number
        embeddedInviteCalls: number
        linkCalls: number
    }
}

const fillForm = async () => {
    const agent = await signIn()

    await agent.put(`/api/transactions/${transactionId}/entries`).send(completeEntries).expect(200)

    const filled = await agent.post(`/api/transactions/${transactionId}/forms/${FORM}/fill`).send({})

    expect(filled.status).toEqual(200)

    return agent
}

const clearEnvelopes = async () => {
    const owned = { agentId: { in: [agentId, otherAgentId] } }

    await prisma.signerEvent.deleteMany({ where: { envelope: { transaction: owned } } })
    await prisma.signingEnvelope.deleteMany({ where: { transaction: owned } })
}

beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD)

    const brokerage = await prisma.brokerage.create({
        data: {
            name: 'Signing Envelope Test Brokerage',
            address: '55 Yonge Street, Suite 400, Toronto, ON M5E 1J4',
            phone: '416-555-0142'
        }
    })

    const created = await prisma.agent.upsert({
        where: { email: EMAIL },
        update: { passwordHash, recoNumber: '4812277', phone: '416-555-0188', brokerageId: brokerage.id },
        create: {
            email: EMAIL,
            name: 'Signing Envelope Test Agent',
            passwordHash,
            recoNumber: '4812277',
            phone: '416-555-0188',
            brokerageId: brokerage.id
        }
    })

    const other = await prisma.agent.upsert({
        where: { email: OTHER_EMAIL },
        update: {},
        create: { email: OTHER_EMAIL, name: 'Other Signing Envelope Agent' }
    })

    agentId = created.id
    otherAgentId = other.id

    const owned = { agentId: { in: [agentId, otherAgentId] } }

    await clearEnvelopes()
    await prisma.complianceCheck.deleteMany({ where: { transactionForm: { transaction: owned } } })
    await prisma.transactionForm.deleteMany({ where: { transaction: owned } })
    await prisma.transactionEntries.deleteMany({ where: { transaction: owned } })
    await prisma.transactionParty.deleteMany({ where: { transaction: owned } })
    await prisma.transaction.deleteMany({ where: owned })

    const transaction = await prisma.transaction.create({
        data: {
            type: 'PURCHASE',
            agent: { connect: { id: agentId } },
            property: {
                create: {
                    address: '18 Maple Grove Avenue',
                    city: 'Toronto',
                    province: 'ON',
                    postalCode: 'M4K 2R7',
                    frontingSide: 'north',
                    frontingStreet: 'Maple Grove Avenue',
                    frontage: '30.02 feet',
                    depth: '120.5 feet',
                    legalDescription: 'LOT 42, PLAN 1187, CITY OF TORONTO'
                }
            },
            parties: {
                create: [
                    {
                        role: 'SELLER',
                        signingOrder: 1,
                        party: {
                            create: {
                                fullLegalName: 'Margaret Anne Whitfield',
                                email: 'm.whitfield@example.test',
                                phone: '647-555-0119',
                                address: '18 Maple Grove Avenue',
                                city: 'Toronto',
                                province: 'ON',
                                postalCode: 'M4K 2R7'
                            }
                        }
                    },
                    {
                        role: 'BUYER',
                        signingOrder: 2,
                        party: {
                            create: {
                                fullLegalName: 'Priya Raghunathan',
                                email: 'p.raghunathan@example.test',
                                phone: '416-555-0164',
                                address: '404 Sherbourne Street, Unit 12',
                                city: 'Toronto',
                                province: 'ON',
                                postalCode: 'M4X 1K2'
                            }
                        }
                    }
                ]
            }
        },
        include: { parties: true }
    })

    const theirs = await prisma.transaction.create({ data: { type: 'PURCHASE', agentId: otherAgentId } })

    transactionId = transaction.id
    otherTransactionId = theirs.id
    sellerPartyId = transaction.parties.find(party => party.role === 'SELLER')!.id

    await fillForm()
})

afterAll(async () => {
    await clearEnvelopes()

    const owned = { agentId: { in: [agentId, otherAgentId] } }

    await prisma.complianceCheck.deleteMany({ where: { transactionForm: { transaction: owned } } })
    await prisma.transactionForm.deleteMany({ where: { transaction: owned } })
    await prisma.transactionEntries.deleteMany({ where: { transaction: owned } })
    await prisma.transactionParty.deleteMany({ where: { transaction: owned } })
    await prisma.transaction.deleteMany({ where: owned })

    await s3
        .send(
            new DeleteObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET,
                Key: keys.filledForm(transactionId, FORM)
            })
        )
        .catch(() => undefined)

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

beforeEach(async () => {
    await clearEnvelopes()

    await prisma.transaction.update({ where: { id: transactionId }, data: { status: 'DRAFT' } })
})

describe('POST /api/transactions/:id/signing', () => {
    it('sends a compliant filled form and moves the transaction', async () => {
        const provider = stubProvider()

        const envelope = await createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider)

        expect(envelope.status).toEqual('sent')
        expect(envelope.formCode).toEqual(FORM)
        expect(envelope.signers.map(signer => signer.order)).toEqual([1, 2])

        // Seller first: signingOrder 1 on the fixture, and the order the form
        // is executed in.
        expect(envelope.signers[0]?.role).toEqual('SELLER')

        const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })
        expect(transaction.status).toEqual('OUT_FOR_SIGNATURE')
    })

    it('refuses a second send for the same form', async () => {
        const provider = stubProvider()

        await createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider)

        await expect(createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider)).rejects.toMatchObject({
            name: 'EnvelopeAlreadySentError'
        })

        expect(await prisma.signingEnvelope.count({ where: { transactionId } })).toEqual(1)
    })

    it('survives two concurrent sends, and raises exactly one envelope', async () => {
        // The reason `activeFormId` is a unique index rather than a check: both
        // of these pass any check-then-act.
        const provider = stubProvider()

        const results = await Promise.allSettled([
            createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider),
            createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider)
        ])

        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(await prisma.signingEnvelope.count({ where: { transactionId } })).toEqual(1)
    })

    it('will not send a form that has never been filled', async () => {
        const provider = stubProvider()

        const row = await prisma.transactionForm.findFirstOrThrow({ where: { transactionId } })

        // The row exists — the agent opened the form — but no PDF was ever
        // drawn. That is the state this guards, and it is not the same as
        // having no template.
        await prisma.transactionForm.update({ where: { id: row.id }, data: { filledS3Key: null } })

        try {
            await expect(
                createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider)
            ).rejects.toMatchObject({ name: 'FormNotFilledError' })

            // The vendor was never called. Sending a document the agent has not
            // looked at is not a convenience.
            expect(provider.prepareCalls).toEqual(0)
        } finally {
            await prisma.transactionForm.update({
                where: { id: row.id },
                data: { filledS3Key: row.filledS3Key }
            })
        }
    })

    it('will not send a form with no curated template', async () => {
        const provider = stubProvider()

        // 320 has a `.raw.json` and no curated `.json`, so it has geometry and
        // no names — deliberately not fillable, and so not sendable.
        await expect(createEnvelopeForForm(transactionId, agentId, '320', 'email', provider)).rejects.toMatchObject({
            name: 'TemplateNotFoundError'
        })

        expect(provider.prepareCalls).toEqual(0)
    })

    it('answers 404 for another agent’s transaction, and 401 with no session', async () => {
        const agent = await signIn()

        await agent.post(`/api/transactions/${otherTransactionId}/signing`).send({ formCode: FORM }).expect(404)

        await request(app).post(`/api/transactions/${transactionId}/signing`).send({ formCode: FORM }).expect(401)
    })

    it('rejects a body that is not a form code', async () => {
        const agent = await signIn()

        const response = await agent.post(`/api/transactions/${transactionId}/signing`).send({}).expect(400)

        expect(response.body.error).toEqual('invalid_request')
    })
})

describe('the parties have to be invitable, which the compliance gate does not guarantee', () => {
    afterEach(async () => {
        await prisma.party.updateMany({
            where: { roles: { some: { id: sellerPartyId } } },
            data: { email: 'm.whitfield@example.test' }
        })

        await prisma.transactionParty.update({
            where: { id: sellerPartyId },
            data: { signingOrder: 1 }
        })
    })

    it('refuses a party with no email, and names no client in doing so', async () => {
        await prisma.party.updateMany({
            where: { roles: { some: { id: sellerPartyId } } },
            data: { email: null }
        })

        const provider = stubProvider()

        await expect(createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider)).rejects.toBeInstanceOf(
            SignerValidationError
        )

        // Caught before the vendor call: an incomplete party list must never
        // become a live document.
        expect(provider.prepareCalls).toEqual(0)

        const failure = await createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider).catch(
            (error: SignerValidationError) => error
        )

        const body = JSON.stringify((failure as SignerValidationError).failures)

        expect(body).toContain('email')
        // Rule 6: not the name, and not the address.
        expect(body).not.toContain('Whitfield')
        expect(body).not.toContain('@')
    })

    it('refuses two parties at the same signing position', async () => {
        await prisma.transactionParty.update({ where: { id: sellerPartyId }, data: { signingOrder: 2 } })

        await expect(
            createEnvelopeForForm(transactionId, agentId, FORM, 'email', stubProvider())
        ).rejects.toBeInstanceOf(SignerValidationError)
    })

    it('refuses a mix of set and unset positions', async () => {
        await prisma.transactionParty.update({ where: { id: sellerPartyId }, data: { signingOrder: null } })

        await expect(
            createEnvelopeForForm(transactionId, agentId, FORM, 'email', stubProvider())
        ).rejects.toBeInstanceOf(SignerValidationError)
    })
})

describe('when the vendor fails part-way', () => {
    it('leaves no envelope at all when preparing the document fails', async () => {
        const provider = stubProvider({
            prepareDocument: async () => {
                throw new SignNowError('unavailable', 'nope')
            }
        })

        await expect(createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider)).rejects.toBeInstanceOf(
            SignNowError
        )

        expect(await prisma.signingEnvelope.count({ where: { transactionId } })).toEqual(0)

        const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })
        expect(transaction.status).toEqual('DRAFT')
    })

    it('leaves a resumable envelope when the invite fails, and does not upload twice', async () => {
        let allowInvite = false

        const provider = stubProvider({
            inviteSigners: async (_externalId, input) => {
                if (!allowInvite) {
                    throw new SignNowError('unavailable', 'nope')
                }

                return {
                    invited: input.signers.map(signer => ({
                        transactionPartyId: signer.transactionPartyId,
                        order: signer.order
                    }))
                }
            }
        })

        await expect(createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider)).rejects.toBeInstanceOf(
            SignNowError
        )

        const stranded = await prisma.signingEnvelope.findFirstOrThrow({ where: { transactionId } })

        // The row exists before anybody is invited, which is the whole reason
        // preparing and inviting are separate calls.
        expect(stranded.status).toEqual('created')

        allowInvite = true

        const resumed = await createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider)

        expect(resumed.status).toEqual('sent')
        expect(resumed.id).toEqual(stranded.id)

        // Resumed, not re-uploaded. Fields cannot be re-placed once a document
        // has been sent, and this one never was.
        expect(provider.prepareCalls).toEqual(1)
        expect(await prisma.signingEnvelope.count({ where: { transactionId } })).toEqual(1)
    })
})

describe('GET /api/transactions/:id/signing', () => {
    it('lists the envelopes, newest first', async () => {
        await createEnvelopeForForm(transactionId, agentId, FORM, 'email', stubProvider())

        const agent = await signIn()
        const response = await agent.get(`/api/transactions/${transactionId}/signing`).expect(200)

        expect(response.body.envelopes).toHaveLength(1)
        expect(response.body.envelopes[0].formCode).toEqual(FORM)

        // No email and no legal name cross the wire.
        expect(JSON.stringify(response.body)).not.toContain('@')
        expect(JSON.stringify(response.body)).not.toContain('Whitfield')
    })

    it('answers 404 for another agent’s transaction', async () => {
        const agent = await signIn()

        await agent.get(`/api/transactions/${otherTransactionId}/signing`).expect(404)
    })
})

describe('embedded signing, where nobody is emailed', () => {
    it('takes the embedded path, and emails nobody at all', async () => {
        const provider = stubProvider()

        const envelope = await createEnvelopeForForm(transactionId, agentId, FORM, 'embedded', provider)

        expect(envelope.delivery).toEqual('embedded')
        expect(provider.embeddedInviteCalls).toEqual(1)

        // The assertion that proves the fork actually forked. An embedded send
        // that also emailed the signers would pass every other check here.
        expect(provider.inviteCalls).toEqual(0)
    })

    /*
     * Pinned deliberately. The UI offers embedded first, but the API's default
     * is what an omitted field means — and an omission must not be the thing
     * that decides whether a client receives an email about a contract. If
     * somebody flips the default, this fails rather than the clients finding out.
     */
    it('still emails when the request does not say, which is the old behaviour', async () => {
        const provider = stubProvider()

        const agent = await fillForm()
        const response = await agent
            .post(`/api/transactions/${transactionId}/signing`)
            .send({ formCode: FORM })
            .expect(201)

        expect(response.body.envelope.delivery).toEqual('email')

        void provider
    })

    it('stores an invite id per signer, and never returns one', async () => {
        const provider = stubProvider()

        const envelope = await createEnvelopeForForm(transactionId, agentId, FORM, 'embedded', provider)

        const row = await prisma.signingEnvelope.findUniqueOrThrow({ where: { id: envelope.id } })
        const stored = row.signers as { externalInviteId?: string }[]

        expect(stored.every(signer => signer.externalInviteId?.length === 40)).toBe(true)

        // A vendor id the browser has no business holding: it is what a link
        // request is addressed by. Same treatment as `externalRoleId`.
        expect(JSON.stringify(envelope)).not.toContain('externalInviteId')
    })

    it('refuses to resume an embedded envelope as an email one', async () => {
        let allowInvite = false

        const provider = stubProvider({
            async inviteSignersEmbedded(_externalId, input) {
                if (!allowInvite) {
                    throw new SignNowError('unavailable', 'the vendor was unreachable')
                }

                return {
                    invited: input.signers.map(signer => ({
                        transactionPartyId: signer.transactionPartyId,
                        order: signer.order,
                        externalInviteId: 'd'.repeat(40)
                    }))
                }
            }
        })

        await expect(
            createEnvelopeForForm(transactionId, agentId, FORM, 'embedded', provider)
        ).rejects.toBeInstanceOf(SignNowError)

        allowInvite = true

        // Emailing the signers now would send a client a document the agent
        // deliberately chose not to send them.
        await expect(
            createEnvelopeForForm(transactionId, agentId, FORM, 'email', provider)
        ).rejects.toMatchObject({ name: 'EnvelopeDeliveryMismatchError' })

        const resumed = await createEnvelopeForForm(transactionId, agentId, FORM, 'embedded', provider)

        expect(resumed.status).toEqual('sent')
    })
})

describe('POST /api/transactions/:id/signing/:envelopeId/link', () => {
    // Signed in once, so `mint` stays a supertest chain rather than a promise
    // of one and `.expect(...)` still reads the way it does everywhere else.
    let signedIn: Awaited<ReturnType<typeof signIn>>

    beforeAll(async () => {
        signedIn = await signIn()
    })

    const mint = (envelopeId: string, transactionPartyId: string) =>
        signedIn
            .post(`/api/transactions/${transactionId}/signing/${envelopeId}/link`)
            .send({ transactionPartyId })

    it('mints a link for the signer whose turn it is', async () => {
        const envelope = await createEnvelopeForForm(
            transactionId,
            agentId,
            FORM,
            'embedded',
            stubProvider()
        )

        const response = await mint(envelope.id, sellerPartyId).expect(200)

        expect(response.body.url).toContain('mock.invalid')
        expect(response.body.expiresInSeconds).toBeGreaterThan(0)
        expect(response.body.transactionPartyId).toEqual(sellerPartyId)

        // A credential in a body, so no shared cache may keep it.
        expect(response.headers['cache-control']).toEqual('no-store')

        // Rule 6 holds here as everywhere else.
        expect(JSON.stringify(response.body)).not.toContain('@')
        expect(JSON.stringify(response.body)).not.toContain('Whitfield')
    })

    it('refuses an envelope that was emailed instead', async () => {
        const envelope = await createEnvelopeForForm(transactionId, agentId, FORM, 'email', stubProvider())

        const response = await mint(envelope.id, sellerPartyId).expect(409)

        expect(response.body.error).toEqual('envelope_not_embedded')
    })

    it('answers 404 for an envelope on another agent’s transaction', async () => {
        const envelope = await createEnvelopeForForm(
            transactionId,
            agentId,
            FORM,
            'embedded',
            stubProvider()
        )

        const agent = await signIn()

        // A real envelope id, under a transaction the caller does not own. The
        // id selects; it does not grant.
        await agent
            .post(`/api/transactions/${otherTransactionId}/signing/${envelope.id}/link`)
            .send({ transactionPartyId: sellerPartyId })
            .expect(404)
    })

    it('answers 404 for a party who is not a signer on it', async () => {
        const envelope = await createEnvelopeForForm(
            transactionId,
            agentId,
            FORM,
            'embedded',
            stubProvider()
        )

        const response = await mint(envelope.id, 'not-a-party-on-this-envelope').expect(404)

        expect(response.body.error).toEqual('signer_not_on_envelope')
    })

    /*
     * These two drive `mockProvider` rather than the stub above. The route
     * resolves its own provider — a controller does not take one — so the only
     * way to make the vendor fail behind an HTTP request is to make the
     * configured provider fail, which is what `SIGNNOW_PROVIDER=mock` and
     * `test/helpers/signNowMock` are for.
     */
    it('turns the vendor’s “not your turn” into something an agent can read', async () => {
        const envelope = await createEnvelopeForForm(
            transactionId,
            agentId,
            FORM,
            'embedded',
            stubProvider()
        )

        // Exactly what the trial answered when asked for signer 2's link before
        // signer 1 had signed — captured in
        // `embedded-invite-link-order2.error.json`, finding 21.
        jest.spyOn(mockProvider, 'embeddedSigningLink').mockRejectedValue(
            new SignNowError(
                'rejected',
                'signNow refused the request: The field invite is not pending or fulfilled.',
                403,
                SIGNNOW_NOT_THIS_SIGNERS_TURN
            )
        )

        const response = await mint(envelope.id, sellerPartyId).expect(409)

        // Not a 502. Nothing failed — there is a queue and this signer is in it.
        expect(response.body.error).toEqual('signer_not_yet_invited')

        jest.restoreAllMocks()
    })

    it('answers 502 for a vendor failure that is a real one', async () => {
        const envelope = await createEnvelopeForForm(
            transactionId,
            agentId,
            FORM,
            'embedded',
            stubProvider()
        )

        __setMockOutcome('unavailable')

        const response = await mint(envelope.id, sellerPartyId).expect(502)

        expect(response.body.error).toEqual('signing_unavailable')

        __setMockOutcome(null)
    })

    it('rejects a body that does not name a party', async () => {
        const envelope = await createEnvelopeForForm(
            transactionId,
            agentId,
            FORM,
            'embedded',
            stubProvider()
        )

        const agent = await signIn()

        await agent
            .post(`/api/transactions/${transactionId}/signing/${envelope.id}/link`)
            .send({})
            .expect(400)
    })

    it('never writes the link to a log', async () => {
        const envelope = await createEnvelopeForForm(
            transactionId,
            agentId,
            FORM,
            'embedded',
            stubProvider()
        )

        const written: unknown[] = []

        for (const level of ['info', 'warn', 'error', 'debug'] as const) {
            jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
                written.push(...args)

                return undefined as never
            })
        }

        const response = await mint(envelope.id, sellerPartyId).expect(200)

        expect(JSON.stringify(written)).not.toContain(response.body.url)
        expect(JSON.stringify(written)).not.toContain('mock.invalid')

        jest.restoreAllMocks()
    })
})
