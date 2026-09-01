import bcrypt from 'bcryptjs'
import { PrismaClient, TransactionType, TransactionStatus, PartyRole } from '@prisma/client'

const prisma = new PrismaClient()

// Deterministic ids for the domain rows so the seed is idempotent — the models
// they belong to have no natural unique key to upsert against.
const BROKERAGE_ID = 'seed_brokerage_0001'

/**
 * The brokerage preset table (build plan 1.1). Picking one on the profile form
 * is what fills the address and phone shown beside the select, so these rows
 * are the only source of that detail — an agent never types it.
 *
 * Deterministic ids keep the seed idempotent and let the first entry stay the
 * one the seeded agent belongs to. Fictional brokerages with 555 numbers: this
 * is development data, and a real brokerage's name against an invented address
 * would be worse than an obviously invented one.
 */
const BROKERAGE_PRESETS = [
    {
        id: BROKERAGE_ID,
        name: 'Realax Realty Inc., Brokerage',
        address: '55 Yonge Street, Suite 400, Toronto, ON M5E 1J4',
        phone: '416-555-0142'
    },
    {
        id: 'seed_brokerage_0002',
        name: 'Bayview Heights Real Estate Ltd., Brokerage',
        address: '2900 Bayview Avenue, Unit 12, North York, ON M2K 1E6',
        phone: '416-555-0173'
    },
    {
        id: 'seed_brokerage_0003',
        name: 'Cabbagetown Property Group Inc., Brokerage',
        address: '410 Parliament Street, Toronto, ON M5A 3A2',
        phone: '416-555-0126'
    },
    {
        id: 'seed_brokerage_0004',
        name: 'Lakeshore West Realty Corp., Brokerage',
        address: '1183 Lakeshore Road East, Mississauga, ON L5E 1E9',
        phone: '905-555-0154'
    },
    {
        id: 'seed_brokerage_0005',
        name: 'Oakridge Home Realty Inc., Brokerage',
        address: '88 Main Street North, Markham, ON L3P 1X5',
        phone: '905-555-0198'
    },
    {
        id: 'seed_brokerage_0006',
        name: 'Rideau Canal Realty Ltd., Brokerage',
        address: '245 Bank Street, Suite 3, Ottawa, ON K2P 1X4',
        phone: '613-555-0161'
    }
]
const PROPERTY_ID = 'seed_property_0001'
const TRANSACTION_ID = 'seed_transaction_0001'
const PARTY_ID = 'seed_party_0001'

const AGENT_EMAIL = 'darren@realax.test'

// Local development credential for the one seeded agent. Override with
// SEED_AGENT_PASSWORD before seeding anything that is not a throwaway database
// — this default is in version control and is therefore public.
const AGENT_PASSWORD = process.env.SEED_AGENT_PASSWORD || 'realax-dev-password'

async function seedRealax() {
    // The brokerage preset table. `update` carries the detail so a corrected
    // address here reaches an existing database on the next seed run — these
    // rows are reference data we own, not something an agent has edited.
    const brokerages = await Promise.all(
        BROKERAGE_PRESETS.map(preset =>
            prisma.brokerage.upsert({
                where: { id: preset.id },
                update: { name: preset.name, address: preset.address, phone: preset.phone },
                create: preset
            })
        )
    )

    const brokerage = brokerages[0]

    // One agent, attached to that brokerage. Same bcrypt cost factor as
    // `auth.service.ts` uses for a real password change.
    const passwordHash = await bcrypt.hash(AGENT_PASSWORD, 12)

    const agent = await prisma.agent.upsert({
        where: { email: AGENT_EMAIL },
        update: { brokerageId: brokerage.id, passwordHash },
        create: {
            email: AGENT_EMAIL,
            name: 'Darren Fischer',
            passwordHash,
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

    console.log('seeded brokerages :', brokerages.length, 'presets')
    console.log('agent brokerage   :', brokerage.id, brokerage.name)
    console.log('seeded agent      :', agent.id, agent.email)
    console.log('seeded property   :', property.id, property.address)
    console.log('seeded transaction:', transaction.id, transaction.type, transaction.status)
    console.log('login with       :', AGENT_EMAIL, '/', AGENT_PASSWORD)
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
