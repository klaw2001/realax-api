import './helpers/signNowMock'

import { createHmac } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'

// Build plan 3.3. The acceptance criterion is "replaying the same webhook twice
// produces one state change", and it is the second test here.
//
// Fixtures are read as Buffers and never parsed-then-restringified: the
// signature is over bytes, and a test that re-serialises the body is testing
// something else.

const FIXTURES = join(__dirname, 'fixtures', 'signnow')

const SECRET = 'signing-test-secret-not-the-real-one'

const EMAIL = 'signnow.webhook.test.agent@realax.test'

/** The document id every captured callback refers to. */
const CAPTURED_DOCUMENT_ID = '08ba14321d484b30a3dd74a0bf3cd40d8dee71b8'

let agentId = ''
let transactionId = ''
let envelopeId = ''

const raw = (name: string): Buffer => readFileSync(join(FIXTURES, name))

const sign = (body: Buffer): string => createHmac('sha256', SECRET).update(body).digest('base64')

/**
 * Deliver a callback the way signNow would: exact bytes, plus a signature.
 *
 * `.send(buffer)` is what you would reach for and it is wrong — superagent
 * JSON-serialises a Buffer into `{"type":"Buffer","data":[...]}`, so a 584-byte
 * fixture arrives as 2011 bytes of something else. The signature could never
 * match, and every acceptance test would fail while every rejection test
 * passed, which looks exactly like a broken verifier.
 *
 * Sending the string keeps the bytes identical — verified: the route receives
 * a Buffer that `.equals()` the fixture.
 */
const deliver = (body: Buffer, signature: string | null = null) => {
    const req = request(app)
        .post('/webhooks/signnow')
        .set('Content-Type', 'application/json')

    if (signature !== null) {
        req.set('x-signnow-signature', signature)
    }

    return req.send(body.toString('utf8'))
}

const events = () => prisma.signerEvent.findMany({ where: { envelopeId } })

const envelope = () => prisma.signingEnvelope.findUniqueOrThrow({ where: { id: envelopeId } })

const freshEnvelope = async (status = 'sent') => {
    await prisma.signerEvent.deleteMany({ where: { envelope: { transactionId } } })
    await prisma.signingEnvelope.deleteMany({ where: { transactionId } })

    const created = await prisma.signingEnvelope.create({
        data: {
            transactionId,
            externalId: CAPTURED_DOCUMENT_ID,
            status,
            signers: []
        }
    })

    envelopeId = created.id
}

beforeAll(async () => {
    const agent = await prisma.agent.upsert({
        where: { email: EMAIL },
        update: {},
        create: { email: EMAIL, name: 'SignNow Webhook Test Agent' }
    })

    agentId = agent.id

    // Child to parent. A test that fails part-way can leave a TransactionForm
    // behind, and the transaction cannot be deleted while one points at it.
    await prisma.signerEvent.deleteMany({ where: { envelope: { transaction: { agentId } } } })
    await prisma.signingEnvelope.deleteMany({ where: { transaction: { agentId } } })
    await prisma.complianceCheck.deleteMany({ where: { transactionForm: { transaction: { agentId } } } })
    await prisma.transactionForm.deleteMany({ where: { transaction: { agentId } } })
    await prisma.transaction.deleteMany({ where: { agentId } })

    const transaction = await prisma.transaction.create({ data: { type: 'LISTING', agentId } })

    transactionId = transaction.id
})

afterAll(async () => {
    // Child to parent. A test that fails part-way can leave a TransactionForm
    // behind, and the transaction cannot be deleted while one points at it.
    await prisma.signerEvent.deleteMany({ where: { envelope: { transaction: { agentId } } } })
    await prisma.signingEnvelope.deleteMany({ where: { transaction: { agentId } } })
    await prisma.complianceCheck.deleteMany({ where: { transactionForm: { transaction: { agentId } } } })
    await prisma.transactionForm.deleteMany({ where: { transaction: { agentId } } })
    await prisma.transaction.deleteMany({ where: { agentId } })

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

beforeEach(async () => {
    await freshEnvelope()
})

describe('a verified callback', () => {
    it('is recorded, and moves the envelope', async () => {
        const body = raw('webhook.04.user.document.fieldinvite.signed.json')

        await deliver(body, sign(body)).expect(200)

        expect(await events()).toHaveLength(1)
        expect((await envelope()).status).toEqual('signed')
    })

    it('replayed, produces one event and one state change', async () => {
        // The 3.3 acceptance criterion. signNow retries five times ten seconds
        // apart and five more four hours apart, redelivering identical bytes.
        const body = raw('webhook.04.user.document.fieldinvite.signed.json')
        const signature = sign(body)

        await deliver(body, signature).expect(200)

        const first = await envelope()

        await deliver(body, signature).expect(200)

        const second = await envelope()

        expect(await events()).toHaveLength(1)
        expect(second.status).toEqual(first.status)
        expect(second.updatedAt.getTime()).toEqual(first.updatedAt.getTime())
    })

    it('records the document completing', async () => {
        // A different content shape: no invite_id, no signer.
        const body = raw('webhook.07.user.document.complete.json')

        await deliver(body, sign(body)).expect(200)

        expect((await envelope()).status).toEqual('completed')
    })

    it('does not touch the transaction, which is 3.4’s job', async () => {
        const body = raw('webhook.07.user.document.complete.json')

        await deliver(body, sign(body)).expect(200)

        const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })

        // COMPLETED means the signed PDF and the audit certificate are stored.
        // Neither exists yet.
        expect(transaction.status).not.toEqual('COMPLETED')
    })
})

describe('what it refuses, and how', () => {
    // Every case here answers 200 on purpose. signNow gives 4xx no retries and
    // unsubscribes a URL after 30 of them in an hour, so a 401 would lose us
    // the subscription within an afternoon of any bug that triggers it. Do not
    // "fix" these to 4xx.

    it('answers 200 to a bad signature, and records nothing', async () => {
        const body = raw('webhook.04.user.document.fieldinvite.signed.json')

        await deliver(body, sign(Buffer.from('a different body'))).expect(200)

        expect(await events()).toHaveLength(0)
        expect((await envelope()).status).toEqual('sent')
    })

    it('answers 200 with no signature header at all', async () => {
        const body = raw('webhook.04.user.document.fieldinvite.signed.json')

        await deliver(body).expect(200)

        expect(await events()).toHaveLength(0)
    })

    it('answers 200 to a body that is not json', async () => {
        const body = Buffer.from('not json at all')

        await deliver(body, sign(body)).expect(200)

        expect(await events()).toHaveLength(0)
    })

    it('answers 200 to json that is not a callback we understand', async () => {
        const body = Buffer.from(JSON.stringify({ hello: 'world' }))

        await deliver(body, sign(body)).expect(200)

        expect(await events()).toHaveLength(0)
    })

    it('answers 200 for a document we never sent, and records nothing', async () => {
        const body = Buffer.from(
            JSON.stringify({
                meta: { event: 'user.document.complete' },
                content: { document_id: 'f'.repeat(40) }
            })
        )

        await deliver(body, sign(body)).expect(200)

        expect(await events()).toHaveLength(0)
    })
})

describe('the signature is over bytes, not over the parsed object', () => {
    it('rejects a body that was re-serialised, even though it is the same JSON', async () => {
        const original = raw('webhook.04.user.document.fieldinvite.signed.json')

        // Same data, different bytes — the fixture is pretty-printed.
        const reserialised = Buffer.from(JSON.stringify(JSON.parse(original.toString('utf8'))))

        expect(reserialised.equals(original)).toBe(false)

        await deliver(reserialised, sign(original)).expect(200)

        expect(await events()).toHaveLength(0)

        // And the same bytes it was signed over do work, so the difference is
        // the serialisation rather than the fixture.
        await deliver(original, sign(original)).expect(200)

        expect(await events()).toHaveLength(1)
    })
})

describe('events arriving out of order', () => {
    it('does not walk a completed envelope backwards', async () => {
        const complete = raw('webhook.07.user.document.complete.json')
        const sent = raw('webhook.03.user.document.fieldinvite.sent.json')

        await deliver(complete, sign(complete)).expect(200)
        expect((await envelope()).status).toEqual('completed')

        // A retry of an earlier event, landing up to four hours later.
        await deliver(sent, sign(sent)).expect(200)

        expect((await envelope()).status).toEqual('completed')

        // Recorded even though it changed nothing: the event log is the record
        // of what the vendor told us, not of what we acted on.
        expect(await events()).toHaveLength(2)
    })
})

describe('where the route sits', () => {
    it('is reachable with no session', async () => {
        const body = raw('webhook.04.user.document.fieldinvite.signed.json')

        // Proves it is mounted above `app.use('/api', requireAgent)`. If it
        // ever moves below, this is a 401 and every callback is lost.
        await deliver(body, sign(body)).expect(200)
    })

    it('is not reachable under /api', async () => {
        // The guard still covers everything it should — `error-middleware`
        // asserts an unmatched /api path is 401 rather than 404.
        await request(app).post('/api/webhooks/signnow').send({}).expect(401)
    })
})

describe('a declined envelope releases its form', () => {
    it('clears activeFormId so another envelope can be raised', async () => {
        const template = await prisma.formTemplate.upsert({
            where: { formCode_revision: { formCode: 'WEBHOOK-TEST', revision: 'test' } },
            update: {},
            create: {
                formCode: 'WEBHOOK-TEST',
                revision: 'test',
                sourceSha256: 'not-a-real-hash',
                sourceS3Key: 'test/webhook-test.pdf',
                fieldMap: {}
            }
        })

        const form = await prisma.transactionForm.create({
            data: { transactionId, formTemplateId: template.id, values: {} }
        })

        await prisma.signingEnvelope.update({
            where: { id: envelopeId },
            data: { transactionFormId: form.id, activeFormId: form.id }
        })

        const body = Buffer.from(
            JSON.stringify({
                meta: { event: 'user.document.fieldinvite.decline' },
                content: { document_id: CAPTURED_DOCUMENT_ID }
            })
        )

        await deliver(body, sign(body)).expect(200)

        const declined = await envelope()

        expect(declined.status).toEqual('declined')
        expect(declined.activeFormId).toBeNull()

        // The unique index is free again, which is the point of clearing it.
        const replacement = await prisma.signingEnvelope.create({
            data: {
                transactionId,
                externalId: 'c'.repeat(40),
                status: 'created',
                activeFormId: form.id,
                signers: []
            }
        })

        expect(replacement.activeFormId).toEqual(form.id)

        await prisma.signingEnvelope.delete({ where: { id: replacement.id } })
        await prisma.transactionForm.delete({ where: { id: form.id } })
    })
})
