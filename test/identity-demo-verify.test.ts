import './helpers/demoModeOn'

import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import { hashPassword } from '../src/modules/auth/auth.service'

// UX plan item 02 — the demo override.
//
// What is being checked is not really "does the button work". It is that what
// the button writes can never be mistaken for a verification: its method is not
// a FINTRAC method, it holds no document, and it refuses to sit beside a real
// record.

const EMAIL = 'demo.verify.agent@realax.test'
const PASSWORD = 'a-correct-test-password'

let agentId = ''
let transactionId = ''
let transactionPartyId = ''
let personId = ''

const signIn = async () => {
    const agent = request.agent(app)
    const response = await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })

    expect(response.status).toEqual(200)

    return agent
}

beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD)

    const agent = await prisma.agent.upsert({
        where: { email: EMAIL },
        update: { passwordHash },
        create: { email: EMAIL, name: 'Demo Verify Agent', passwordHash }
    })

    agentId = agent.id

    const transaction = await prisma.transaction.create({
        data: {
            type: 'LISTING',
            agentId,
            parties: {
                create: {
                    role: 'SELLER',
                    signingOrder: 1,
                    party: { create: { fullLegalName: 'Demo Override Seller' } }
                }
            }
        },
        select: { id: true, parties: { select: { id: true, partyId: true } } }
    })

    transactionId = transaction.id
    transactionPartyId = transaction.parties[0].id
    personId = transaction.parties[0].partyId
})

afterAll(async () => {
    await prisma.identityRecord.deleteMany({ where: { partyId: personId } })
    await prisma.document.deleteMany({ where: { transactionId } })
    await prisma.transactionParty.deleteMany({ where: { transactionId } })
    await prisma.transaction.deleteMany({ where: { agentId } })
    await prisma.party.deleteMany({ where: { id: personId } })
    await prisma.agent.deleteMany({ where: { email: EMAIL } })

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

describe('the demo override, on a build that has it', () => {
    test('one call marks the party verified', async () => {
        const agent = await signIn()

        const response = await agent.post(
            `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity/demo-verify`
        )

        expect(response.status).toEqual(201)
        expect(response.body.record.partyId).toEqual(personId)

        // Not expired, or the identity tile would still show the party as
        // unverified and the whole point of the button would be missed.
        expect(response.body.record.expired).toEqual(false)
    })

    test('what it writes is not a verification, and says so', async () => {
        const record = await prisma.identityRecord.findFirstOrThrow({
            where: { partyId: personId },
            select: { verifiedMethod: true, documentNumber: true, s3Key: true }
        })

        // Not a FINTRAC method, and not one of ours either: no query for real
        // verifications can match it, now or in five years.
        expect(record.verifiedMethod).toEqual('demo_override')
        expect(record.verifiedMethod).not.toEqual('government_photo_id')
        expect(record.verifiedMethod).not.toEqual('government_photo_id_manual')

        // No document was examined, so there is no number and no object.
        expect(record.documentNumber).toEqual('')
        expect(record.s3Key).toEqual('')
    })

    test('no document row is invented for a document that does not exist', async () => {
        const documents = await prisma.document.count({ where: { transactionId } })

        expect(documents).toEqual(0)
    })

    test('the method reaches the frontend, which has to label it', async () => {
        const agent = await signIn()

        const response = await agent.get(
            `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity`
        )

        expect(response.status).toEqual(200)
        expect(response.body.records).toHaveLength(1)
        expect(response.body.records[0].verifiedMethod).toEqual('demo_override')

        // A fabricated record must not claim to hold a document number.
        expect(response.body.records[0].documentNumberOnFile).toEqual(false)
    })

    test('it refuses to sit beside a record that already exists', async () => {
        const agent = await signIn()

        const response = await agent.post(
            `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity/demo-verify`
        )

        expect(response.status).toEqual(409)
        expect(await prisma.identityRecord.count({ where: { partyId: personId } })).toEqual(1)
    })

    test('somebody else’s transaction is still not found', async () => {
        const agent = await signIn()

        const response = await agent.post(
            `/api/transactions/does-not-exist/parties/${transactionPartyId}/identity/demo-verify`
        )

        expect(response.status).toEqual(404)
    })

    test('a session is still required', async () => {
        const response = await request(app).post(
            `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity/demo-verify`
        )

        expect(response.status).toEqual(401)
    })
})
