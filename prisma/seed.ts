import { PrismaClient, TransactionType, TransactionStatus, PartyRole } from '@prisma/client'

const prisma = new PrismaClient()

// Deterministic ids for the domain rows so the seed is idempotent — the models
// they belong to have no natural unique key to upsert against.
const BROKERAGE_ID = 'seed_brokerage_0001'
const PROPERTY_ID = 'seed_property_0001'
const TRANSACTION_ID = 'seed_transaction_0001'
const PARTY_ID = 'seed_party_0001'

const AGENT_EMAIL = 'darren@realax.test'

async function seedRealax() {
    // One brokerage. The preset table proper is filled out in Phase 1.1, where
    // selecting a brokerage autofills address and phone on the agent profile.
    const brokerage = await prisma.brokerage.upsert({
        where: { id: BROKERAGE_ID },
        update: {},
        create: {
            id: BROKERAGE_ID,
            name: 'Realax Realty Inc., Brokerage',
            address: '55 Yonge Street, Suite 400, Toronto, ON M5E 1J4',
            phone: '416-555-0142'
        }
    })

    // One agent, attached to that brokerage.
    const agent = await prisma.agent.upsert({
        where: { email: AGENT_EMAIL },
        update: { brokerageId: brokerage.id },
        create: {
            email: AGENT_EMAIL,
            name: 'Darren Fischer',
            recoNumber: '4812277',
            phone: '416-555-0188',
            brokerageId: brokerage.id
        }
    })

    // A property for the transaction to point at.
    const property = await prisma.property.upsert({
        where: { id: PROPERTY_ID },
        update: {},
        create: {
            id: PROPERTY_ID,
            mlsNumber: 'C8123456',
            address: '18 Maple Grove Avenue',
            city: 'Toronto',
            province: 'ON',
            postalCode: 'M4K 2R7',
            frontingSide: 'north',
            frontingStreet: 'Maple Grove Avenue',
            frontage: '30.02 feet',
            depth: '120.5 feet',
            legalDescription: 'LOT 42, PLAN 1187, CITY OF TORONTO',
            listPrice: 1249000,
            taxes: '6,842.17 (2025)'
        }
    })

    // One transaction, owned by the agent.
    const transaction = await prisma.transaction.upsert({
        where: { id: TRANSACTION_ID },
        update: {},
        create: {
            id: TRANSACTION_ID,
            type: TransactionType.LISTING,
            status: TransactionStatus.DRAFT,
            agentId: agent.id,
            propertyId: property.id
        }
    })

    // A seller on the transaction, so the join table has a row to inspect in
    // `prisma studio` alongside the agent → transaction → property chain.
    const party = await prisma.party.upsert({
        where: { id: PARTY_ID },
        update: {},
        create: {
            id: PARTY_ID,
            fullLegalName: 'Margaret Anne Whitfield',
            email: 'm.whitfield@example.test',
            phone: '647-555-0119'
        }
    })

    await prisma.transactionParty.upsert({
        where: {
            transactionId_partyId_role: {
                transactionId: transaction.id,
                partyId: party.id,
                role: PartyRole.SELLER
            }
        },
        update: {},
        create: {
            transactionId: transaction.id,
            partyId: party.id,
            role: PartyRole.SELLER,
            signingOrder: 1
        }
    })

    console.log('seeded brokerage  :', brokerage.id, brokerage.name)
    console.log('seeded agent      :', agent.id, agent.email)
    console.log('seeded property   :', property.id, property.address)
    console.log('seeded transaction:', transaction.id, transaction.type, transaction.status)
}

async function main() {
    await seedRealax()
}

main()
    .catch(e => {
        console.error(e)
        process.exit(1)
    })
    .finally(async () => {
        await prisma.$disconnect()
    })
