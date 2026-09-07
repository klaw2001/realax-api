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
const SELLER_ID = 'seed_party_0001'
const BUYER_ID = 'seed_party_0002'

const AGENT_EMAIL = 'darren@realax.test'

// Local development credential for the one seeded agent. Override with
// SEED_AGENT_PASSWORD before seeding anything that is not a throwaway database
// — this default is in version control and is therefore public.
const AGENT_PASSWORD = process.env.SEED_AGENT_PASSWORD || 'realax-dev-password'

/**
 * The seeded clients' addresses.
 *
 * `.test` by default, because these are invented people and a reserved TLD is
 * the honest thing to give them. But signNow validates a recipient address
 * before it will create an invite and refuses that whole TLD, so sending the
 * demo transaction for signature against the real vendor needs real mailboxes.
 *
 * Overridable rather than hardcoded: whoever is demoing puts their own
 * addresses in `.env`, and nobody's personal inbox ends up in version control.
 * Gmail plus-addressing works well here — both signers land in one inbox.
 */
const SELLER_EMAIL = process.env.SEED_SELLER_EMAIL || 'm.whitfield@example.test'
const BUYER_EMAIL = process.env.SEED_BUYER_EMAIL || 'p.raghunathan@example.test'

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
    const propertyDetail = {
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

    const property = await prisma.property.upsert({
        where: { id: PROPERTY_ID },
        update: propertyDetail,
        create: { id: PROPERTY_ID, ...propertyDetail }
    })

    // One transaction, owned by the agent.
    //
    // The type is in `update` as well as `create`. It is the one field here
    // that changes what a filled form says — it picks which brokerage block the
    // agent's own details print in — so a demo row left on an older type is a
    // Form 100 with the agent on the wrong side of the deal. Everything else is
    // left alone on a re-seed, which is what makes it safe to run repeatedly.
    const transaction = await prisma.transaction.upsert({
        where: { id: TRANSACTION_ID },
        update: { type: TransactionType.PURCHASE },
        create: {
            id: TRANSACTION_ID,
            type: TransactionType.PURCHASE,
            status: TransactionStatus.DRAFT,
            agentId: agent.id,
            propertyId: property.id
        }
    })

    // The seller, with the address block filled: it is the starting point for
    // the "address for service" blanks on Form 100, which the mapper takes from
    // the first party on each side.
    const sellerDetail = {
        fullLegalName: 'Margaret Anne Whitfield',
        email: SELLER_EMAIL,
        phone: '647-555-0119',
        address: '18 Maple Grove Avenue',
        city: 'Toronto',
        province: 'ON',
        postalCode: 'M4K 2R7'
    }

    // The detail is carried in `update` as well as `create`, the same way the
    // brokerage presets are. These are rows we invent, not rows an agent has
    // edited, so a field added here has to reach a database that was seeded
    // before it existed — otherwise the seed stops producing the complete
    // transaction it claims to.
    const seller = await prisma.party.upsert({
        where: { id: SELLER_ID },
        update: sellerDetail,
        create: { id: SELLER_ID, ...sellerDetail }
    })

    // A buyer as well as a seller. Form 100 is an Agreement of Purchase and
    // Sale and names both sides, so a seeded transaction with only a seller
    // cannot produce a complete form — which would make the compliance gate
    // impossible to see passing against seeded data.
    const buyerDetail = {
        fullLegalName: 'Priya Raghunathan',
        email: BUYER_EMAIL,
        phone: '416-555-0164',
        address: '404 Sherbourne Street, Unit 12',
        city: 'Toronto',
        province: 'ON',
        postalCode: 'M4X 1K2'
    }

    const buyer = await prisma.party.upsert({
        where: { id: BUYER_ID },
        update: buyerDetail,
        create: { id: BUYER_ID, ...buyerDetail }
    })

    /*
     * The seller signs first, then the buyer.
     *
     * The position is the loop index rather than a constant. Both parties were
     * seeded at `signingOrder: 1`, which is a set of positions `resolveSigners`
     * refuses outright — two parties explicitly at position 1 means the agent's
     * intent is ambiguous rather than parallel. So the seeded transaction, the
     * one the demo opens, was the one transaction that could never be sent for
     * signature.
     *
     * `update` carries it too, so re-seeding repairs a database that already
     * has the duplicate rather than leaving it for whoever next tries to send.
     */
    for (const [index, [party, role]] of (
        [
            [seller, PartyRole.SELLER],
            [buyer, PartyRole.BUYER]
        ] as const
    ).entries()) {
        const signingOrder = index + 1

        await prisma.transactionParty.upsert({
            where: {
                transactionId_partyId_role: {
                    transactionId: transaction.id,
                    partyId: party.id,
                    role
                }
            },
            update: { signingOrder },
            create: {
                transactionId: transaction.id,
                partyId: party.id,
                role,
                signingOrder
            }
        })
    }

    // The agreement terms — the fifty-two Form 100 blanks the domain model has
    // no column for. Seeded complete on purpose: a transaction that fills
    // cleanly is what makes a transaction that does not fill legible, and the
    // fill engine and the compliance gate both need one to be checked against.
    const entriesDetail = {
        agreementDate: new Date('2026-09-02'),

        purchasePrice: '1225000.00',
        purchasePriceWords: 'One Million Two Hundred Twenty-Five Thousand',

        depositTiming: 'Upon Acceptance',
        depositAmount: '60000.00',
        depositAmountWords: 'Sixty Thousand',
        depositHolder: 'Realax Realty Inc., Brokerage',

        schedulesList: 'A',

        irrevocabilityBoundParty: 'Buyer',
        irrevocabilityTime: '11:59 p.m.',
        irrevocabilityDate: new Date('2026-09-04'),

        completionDate: new Date('2026-11-14'),
        titleSearchDate: new Date('2026-10-24'),

        noticesSellerFax: '416-555-0143',
        noticesBuyerFax: '416-555-0165',

        chattelsIncluded: [
            'Refrigerator',
            'Stove',
            'Built-in dishwasher',
            'Washer and dryer',
            'All existing window coverings',
            'All existing light fixtures'
        ],
        fixturesExcluded: ['Dining room chandelier', 'Garage shelving'],
        rentalItems: ['Hot water tank', 'Furnace and air conditioner'],

        hstTreatment: 'included in',

        propertyPresentUse: 'Single family residential',

        // The other side's block. On a purchase the agent's own profile fills
        // the co-operating one, so this is the listing brokerage — known from
        // the listing, typed in here.
        listingBrokerageName: 'Bayview Heights Real Estate Ltd., Brokerage',
        listingBrokerageTel: '416-555-0173',
        listingBrokerageSalesperson: 'Alan Prakash',

        // Explicitly nulled, not omitted. The upsert above updates the keys it
        // is given and leaves the rest, so a field this seed stops setting keeps
        // whatever an older run put there — and entries beat the profile in the
        // merged object, so a stale value here prints the *other* side's
        // brokerage in the box that is supposed to be the agent's own.
        coopBrokerageName: null,
        coopBrokerageTel: null,
        coopBrokerageSalesperson: null,

        // Form 320, the co-operation confirmation. Only the commission is filled
        // in: the comment blocks are alternatives an agent uses when there is
        // something to disclose, and a seeded deal with nothing to disclose
        // should look like one.
        coopCommissionAmount: '2.5% of the sale price',
        listingBrokerageAddress: '2900 Bayview Avenue, Unit 12',
        listingBrokerageAddress2: 'North York, ON M2K 1E6',
        listingBrokerageFax: '416-555-0174',

        // Form 801, the offer summary. Only the submitted block is required —
        // the counter-offer and the listing brokerage's own timings are marked
        // optional in the curation, and a seeded deal that was not countered
        // should look like one.
        offerSubmittedHow: 'by email',
        offerSubmittedTime: '4:15 p.m.',
        offerSubmittedDate: new Date('2026-09-02T00:00:00.000Z'),

        // Form 371, the buyer representation agreement. Dated before the offer,
        // because that is when it is signed — the buyer engages the brokerage
        // and then goes looking. `designatedRepresentatives` is left unset on
        // purpose: the mapper answers it with the signed-in agent, and seeding a
        // name here would hide that it does.
        commencementTime: '9:00 a.m.',
        commencementDate: new Date('2026-08-03T00:00:00.000Z'),
        expiryDate: new Date('2026-12-01T00:00:00.000Z'),
        buyerRequirementsPropertyType: 'Detached or semi-detached residential, 3+ bedrooms',
        buyerRequirementsGeographicLocation: 'City of Toronto, north of Bloor Street',
        commissionPercent: '2.5',
        holdoverPeriodDays: 90,

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

    const entries = await prisma.transactionEntries.upsert({
        where: { transactionId: transaction.id },
        update: entriesDetail,
        create: { transactionId: transaction.id, ...entriesDetail }
    })

    console.log('seeded brokerages :', brokerages.length, 'presets')
    console.log('agent brokerage   :', brokerage.id, brokerage.name)
    console.log('seeded agent      :', agent.id, agent.email)
    console.log('seeded property   :', property.id, property.address)
    console.log('seeded transaction:', transaction.id, transaction.type, transaction.status)
    console.log('seeded parties    :', seller.fullLegalName, '(seller),', buyer.fullLegalName, '(buyer)')
    console.log('seeded entries    :', entries.id, 'completion', entries.completionDate?.toISOString().slice(0, 10))
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
