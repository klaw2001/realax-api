import { evaluateCompliance } from '../src/modules/compliance/compliance.service'
import { toEntryInput } from '../src/modules/entries/entries.service'
import { renderFilledForm } from '../src/modules/forms/fill.service'
import { buildMergedValues, type TransactionSnapshot } from '../src/modules/forms/mapper.service'
import { loadTemplate } from '../src/modules/forms/template.service'
import type { AgentProfile } from '../src/schemas/agent'
import type { TransactionEntries } from '../src/schemas/entries'
import type { Party } from '../src/schemas/party'
import type { Property } from '../src/schemas/property'

// Build plan 2.4. Unit tests: no database, no S3, no network. The gate is a
// pure function of a snapshot, which is the reason it is one — it decides
// whether a contract may be produced, and a decision like that should be
// reproducible from its inputs.

const FORM = '100'

const agent: AgentProfile = {
    id: 'agent_1',
    email: 'darren@realax.test',
    name: 'Darren Fischer',
    recoNumber: '4812277',
    phone: '416-555-0188',
    brokerageId: 'brokerage_1',
    createdAt: '2026-09-01T09:00:00.000Z',
    brokerage: {
        id: 'brokerage_1',
        name: 'Realax Realty Inc., Brokerage',
        address: '55 Yonge Street, Suite 400, Toronto, ON M5E 1J4',
        phone: '416-555-0142'
    }
}

const property: Property = {
    id: 'property_1',
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

const party = (overrides: Partial<Party> & Pick<Party, 'fullLegalName' | 'role'>): Party => ({
    id: `tp_${overrides.fullLegalName}`,
    personId: `person_${overrides.fullLegalName}`,
    signingOrder: 1,
    email: null,
    phone: null,
    address: null,
    city: null,
    province: null,
    postalCode: null,
    dateOfBirth: null,
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    ...overrides
})

const parties: Party[] = [
    party({
        fullLegalName: 'Margaret Anne Whitfield',
        role: 'SELLER',
        email: 'm.whitfield@example.test',
        phone: '647-555-0119',
        address: '18 Maple Grove Avenue',
        city: 'Toronto',
        province: 'ON',
        postalCode: 'M4K 2R7'
    }),
    party({
        fullLegalName: 'Priya Raghunathan',
        role: 'BUYER',
        email: 'p.raghunathan@example.test',
        phone: '416-555-0164',
        address: '404 Sherbourne Street, Unit 12',
        city: 'Toronto',
        province: 'ON',
        postalCode: 'M4X 1K2'
    })
]

const entries: TransactionEntries = {
    transactionId: 'tx_1',
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
    buyerLawyerFax: '416-555-0132',
    updatedAt: '2026-09-02T09:00:00.000Z'
}

const complete: TransactionSnapshot = {
    transaction: { type: 'LISTING' },
    agent,
    property,
    parties,
    entries: toEntryInput(entries)
}

const check = async (snapshot: TransactionSnapshot) =>
    evaluateCompliance(await loadTemplate(FORM), snapshot)

const fields = (result: { failures: { field: string }[] }) =>
    result.failures.map(failure => failure.field)

describe('a complete transaction', () => {
    test('passes with nothing to report', async () => {
        const result = await check(complete)

        expect(result.failures).toEqual([])
        expect(result.passed).toEqual(true)
        expect(result.formCode).toEqual(FORM)
    })

    test('agrees with the fill engine about what is missing', async () => {
        // The two must not be able to disagree: a gate that passes a form the
        // engine then draws with gaps in it is worse than no gate. Asserted
        // against the engine's own answer rather than trusted.
        const template = await loadTemplate(FORM)
        const rendered = await renderFilledForm(template, buildMergedValues(complete))

        expect(rendered.missing).toEqual([])
        expect(await check(complete).then(fields)).toEqual([])
    })
})

describe('an empty transaction', () => {
    test('reports every blank the form names, and passes nothing', async () => {
        const result = await check({ transaction: { type: 'LISTING' } })

        expect(result.passed).toEqual(false)
        expect(result.failures.length).toBeGreaterThan(40)
    })

    test('agrees with the fill engine about what is missing', async () => {
        const sparse: TransactionSnapshot = { transaction: { type: 'LISTING' }, agent }
        const template = await loadTemplate(FORM)

        const rendered = await renderFilledForm(template, buildMergedValues(sparse))
        const result = await check(sparse)

        // The gate reports the same blanks the engine would leave empty, plus
        // the rules the engine knows nothing about — a transaction with no
        // parties on it. So every blank the engine calls missing is either
        // reported by the gate or excused by an absent-party failure that
        // covers it.
        const reported = new Set(fields(result))
        const excused = new Set([
            'buyer.fullLegalNames',
            'seller.fullLegalNames',
            'scheduleA.buyer.fullLegalNames',
            'scheduleA.seller.fullLegalNames',
            'notices.buyerEmail',
            'notices.sellerEmail',
            'buyer.addressForService.line1',
            'buyer.addressForService.line2',
            'buyer.addressForService.tel',
            'seller.addressForService.line1',
            'seller.addressForService.line2',
            'seller.addressForService.tel'
        ])

        const unaccounted = rendered.missing.filter(
            name => !reported.has(name) && !excused.has(name)
        )

        expect(unaccounted).toEqual([])
    })
})

describe('a failure says what it is and where to fix it', () => {
    test('every failure carries a label and a page, never a bare field name', async () => {
        const result = await check({ transaction: { type: 'LISTING' } })

        for (const item of result.failures) {
            expect(item.label.length).toBeGreaterThan(0)

            // A label that is just the field name means the curation is
            // missing one — legible, but not the finished product.
            expect(item.label).not.toEqual(item.field)
            expect(['profile', 'property', 'parties', 'entries']).toContain(item.area)
            expect(item.areaLabel.length).toBeGreaterThan(0)
        }
    })

    test('a missing completion date points at the agreement terms', async () => {
        const result = await check({
            ...complete,
            entries: toEntryInput({ ...entries, completionDate: null })
        })

        const failure = result.failures.find(item => item.field === 'completion.dateDay')

        expect(failure).toEqual({
            field: 'completion.dateDay',
            label: 'Completion date — day',
            area: 'entries',
            areaLabel: 'Agreement terms',
            reason: 'missing'
        })
    })

    test('a missing legal description points at the property', async () => {
        const result = await check({
            ...complete,
            property: { ...property, legalDescription: null }
        })

        expect(result.failures).toEqual([
            {
                field: 'property.legalDescription',
                label: 'Legal description',
                area: 'property',
                areaLabel: 'Property',
                reason: 'missing'
            }
        ])
    })

    test('failures come back in the order the form prints them', async () => {
        const result = await check({
            ...complete,
            entries: toEntryInput({
                ...entries,
                agreementDate: null,
                completionDate: null,
                buyerLawyerName: null
            })
        })

        // Schedule A's dates follow the agreement's, so clearing the one
        // empties four blanks in two places on the form — and they are
        // reported where the form prints them, not where they were derived.
        expect(fields(result)).toEqual([
            'agreement.dateDay',
            'agreement.dateMonth',
            'agreement.dateYear',
            'completion.dateDay',
            'completion.dateMonth',
            'completion.dateYear',
            'buyerLawyer.name',
            'scheduleA.dateDay',
            'scheduleA.dateMonth',
            'scheduleA.dateYear'
        ])
    })
})

describe('parties the transaction type requires', () => {
    test('a listing with no buyer is one item, not six', async () => {
        const result = await check({
            ...complete,
            parties: parties.filter(item => item.role === 'SELLER')
        })

        expect(fields(result)).toEqual(['party.buyer'])
        expect(result.failures[0]).toMatchObject({
            label: 'No buyer on this transaction',
            area: 'parties',
            reason: 'absent'
        })
    })

    test('a buyer who is on the transaction but has no email is reported as that', async () => {
        const result = await check({
            ...complete,
            parties: [parties[0], party({ ...parties[1], email: null })]
        })

        expect(fields(result)).toEqual(['notices.buyerEmail'])
        expect(result.failures[0].reason).toEqual('missing')
    })

    test('a transaction with nobody on it reports both sides', async () => {
        const result = await check({ ...complete, parties: [] })

        expect(fields(result)).toEqual(['party.seller', 'party.buyer'])
    })
})

describe('the agent profile and their brokerage', () => {
    test('a missing RECO number blocks, though no blank on the form carries it', async () => {
        const result = await check({ ...complete, agent: { ...agent, recoNumber: null } })

        expect(fields(result)).toEqual(['agent.recoNumber'])
        expect(result.failures[0].area).toEqual('profile')
    })

    test('no brokerage selected is reported on the profile, with the blank it empties', async () => {
        const result = await check({ ...complete, agent: { ...agent, brokerage: null } })

        // The telephone blank is not among them: the mapper falls back to the
        // agent's own number, so it is filled. Only the name has nothing
        // behind it.
        expect(fields(result)).toEqual(['agent.brokerage', 'listingBrokerage.name'])
    })

    test('a brokerage with no phone passes when the agent has one', async () => {
        const result = await check({
            ...complete,
            agent: { ...agent, brokerage: { ...agent.brokerage!, phone: null } }
        })

        expect(result.passed).toEqual(true)
    })

    test('neither the brokerage nor the agent having a phone does not pass', async () => {
        const result = await check({
            ...complete,
            agent: { ...agent, phone: null, brokerage: { ...agent.brokerage!, phone: null } }
        })

        expect(fields(result)).toEqual(['brokerage.phone', 'listingBrokerage.tel'])
    })

    test("on a listing the agent's own brokerage is fixed on their profile", async () => {
        const result = await check({
            ...complete,
            agent: { ...agent, name: '' }
        })

        const salesperson = result.failures.find(
            item => item.field === 'listingBrokerage.salesperson'
        )

        expect(salesperson?.area).toEqual('profile')
        expect(salesperson?.label).toEqual('Listing brokerage — salesperson name')
    })

    test('on a purchase it is the co-operating block that is theirs', async () => {
        // Purchase is not a wired flow (build plan 1.2). The gate still has to
        // answer correctly for one, because pointing an agent at the wrong page
        // is the same mistake as filling the wrong box, one step later.
        const result = await check({
            ...complete,
            transaction: { type: 'PURCHASE' },
            entries: toEntryInput({
                ...entries,
                coopBrokerageName: null,
                coopBrokerageTel: null,
                coopBrokerageSalesperson: null
            })
        })

        // On a purchase the agent is the co-operating brokerage, so their own
        // profile fills that block — and the listing brokerage is the other
        // side's, typed in with the rest of the agreement.
        const listing = result.failures.find(item => item.field === 'listingBrokerage.name')

        expect(listing?.area).toEqual('entries')
        expect(listing?.label).toEqual('Listing brokerage — brokerage name')
        expect(fields(result)).not.toContain('coopBrokerage.name')
    })
})

describe('the ruled continuation blocks', () => {
    test('an empty block is one missing field, not four empty lines', async () => {
        const result = await check({
            ...complete,
            entries: toEntryInput({ ...entries, chattelsIncluded: [] })
        })

        expect(fields(result)).toEqual(['chattelsIncluded'])
    })
})

describe('the blanks the gate must never ask for', () => {
    test('no signature or signing-date blank is ever reported', async () => {
        const template = await loadTemplate(FORM)
        const result = await check({ transaction: { type: 'LISTING' } })

        const notTheAgents = new Set(
            template.blanks.filter(blank => blank.kind !== 'data').map(blank => blank.name)
        )

        // Counting one of these as missing would block every transaction that
        // has ever existed: they are filled inside the e-sign session, and
        // empty before it is what correct looks like.
        expect(fields(result).filter(field => notTheAgents.has(field))).toEqual([])
    })
})

describe('the check is a pure function of its input', () => {
    test('the same snapshot twice gives the same answer', async () => {
        const at = new Date('2026-09-02T09:00:00.000Z')
        const template = await loadTemplate(FORM)

        expect(evaluateCompliance(template, complete, at)).toEqual(
            evaluateCompliance(template, complete, at)
        )
    })

    test('nothing but the failures decides whether it passed', async () => {
        // There is no override. `passed` is the absence of failures and there
        // is no other way to set it — this is the assertion that says so.
        const result = await check({ ...complete, property: { ...property, depth: null } })

        expect(result.passed).toEqual(result.failures.length === 0)
        expect(result.passed).toEqual(false)
    })
})
