import './helpers/signNowMock'

import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import s3, { keys } from '../src/lib/s3'
import { SignNowError, type SignNowProvider } from '../src/integrations/signnow/provider'
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
    coopBrokerageName: 'Bayview Heights Real Estate Ltd., Brokerage',
    coopBrokerageTel: '416-555-0173',
    coopBrokerageSalesperson: 'Alan Prakash',
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

/** A provider that records what it was asked, and can be told to fail. */
const stubProvider = (
    over: Partial<SignNowProvider> = {}
): SignNowProvider & { prepareCalls: number; inviteCalls: number } => {
    const stub = {
        name: 'stub',
        prepareCalls: 0,
        inviteCalls: 0,
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

    return stub as SignNowProvider & { prepareCalls: number; inviteCalls: number }
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
            type: 'LISTING',
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

    const theirs = await prisma.transaction.create({ data: { type: 'LISTING', agentId: otherAgentId } })

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

        const envelope = await createEnvelopeForForm(transactionId, agentId, FORM, provider)

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

        await createEnvelopeForForm(transactionId, agentId, FORM, provider)

        await expect(createEnvelopeForForm(transactionId, agentId, FORM, provider)).rejects.toMatchObject({
            name: 'EnvelopeAlreadySentError'
        })

        expect(await prisma.signingEnvelope.count({ where: { transactionId } })).toEqual(1)
    })

    it('survives two concurrent sends, and raises exactly one envelope', async () => {
        // The reason `activeFormId` is a unique index rather than a check: both
        // of these pass any check-then-act.
        const provider = stubProvider()

        const results = await Promise.allSettled([
            createEnvelopeForForm(transactionId, agentId, FORM, provider),
            createEnvelopeForForm(transactionId, agentId, FORM, provider)
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
                createEnvelopeForForm(transactionId, agentId, FORM, provider)
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
        await expect(createEnvelopeForForm(transactionId, agentId, '320', provider)).rejects.toMatchObject({
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

        await expect(createEnvelopeForForm(transactionId, agentId, FORM, provider)).rejects.toBeInstanceOf(
            SignerValidationError
        )

        // Caught before the vendor call: an incomplete party list must never
        // become a live document.
        expect(provider.prepareCalls).toEqual(0)

        const failure = await createEnvelopeForForm(transactionId, agentId, FORM, provider).catch(
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
            createEnvelopeForForm(transactionId, agentId, FORM, stubProvider())
        ).rejects.toBeInstanceOf(SignerValidationError)
    })

    it('refuses a mix of set and unset positions', async () => {
        await prisma.transactionParty.update({ where: { id: sellerPartyId }, data: { signingOrder: null } })

        await expect(
            createEnvelopeForForm(transactionId, agentId, FORM, stubProvider())
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

        await expect(createEnvelopeForForm(transactionId, agentId, FORM, provider)).rejects.toBeInstanceOf(
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

        await expect(createEnvelopeForForm(transactionId, agentId, FORM, provider)).rejects.toBeInstanceOf(
            SignNowError
        )

        const stranded = await prisma.signingEnvelope.findFirstOrThrow({ where: { transactionId } })

        // The row exists before anybody is invited, which is the whole reason
        // preparing and inviting are separate calls.
        expect(stranded.status).toEqual('created')

        allowInvite = true

        const resumed = await createEnvelopeForForm(transactionId, agentId, FORM, provider)

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
        await createEnvelopeForForm(transactionId, agentId, FORM, stubProvider())

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
