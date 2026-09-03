import './helpers/demoModeOff'

import request from 'supertest'

import app from '../src/app'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import { hashPassword } from '../src/modules/auth/auth.service'

// The default build. The demo route is not disabled here — it was never
// mounted, which is the difference the plan asked for: with the flag off there
// is no button and no endpoint.

const EMAIL = 'demo.verify.off.agent@realax.test'
const PASSWORD = 'a-correct-test-password'

let agentId = ''
let transactionId = ''
let transactionPartyId = ''
let personId = ''

beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD)

    const agent = await prisma.agent.upsert({
        where: { email: EMAIL },
        update: { passwordHash },
        create: { email: EMAIL, name: 'Demo Off Agent', passwordHash }
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
                    party: { create: { fullLegalName: 'Ordinary Build Seller' } }
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
    await prisma.transactionParty.deleteMany({ where: { transactionId } })
    await prisma.transaction.deleteMany({ where: { agentId } })
    await prisma.party.deleteMany({ where: { id: personId } })
    await prisma.agent.deleteMany({ where: { email: EMAIL } })

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

describe('the demo override, on an ordinary build', () => {
    test('the route does not exist, and no record appears', async () => {
        const agent = request.agent(app)

        await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD }).expect(200)

        const response = await agent.post(
            `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity/demo-verify`
        )

        expect(response.status).toEqual(404)
        expect(await prisma.identityRecord.count({ where: { partyId: personId } })).toEqual(0)
    })
})
