import { describeBlank, evaluateCompliance } from '../src/modules/compliance/compliance.service'
import { toEntryInput } from '../src/modules/entries/entries.service'
import { renderFilledForm } from '../src/modules/forms/fill.service'
import { buildMergedValues, type TransactionSnapshot } from '../src/modules/forms/mapper.service'
import { loadTemplate, reportableBlankNames } from '../src/modules/forms/template.service'
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
    // The other side's block is typed in. The agent's own — the co-operating
    // one on a purchase — is answered by their profile, so nothing types it
    // here; the tests below are what pin which is which.
    listingBrokerageName: 'Bayview Heights Real Estate Ltd., Brokerage',
    listingBrokerageTel: '416-555-0173',
    listingBrokerageSalesperson: 'Alan Prakash',
    coopBrokerageName: null,
    coopBrokerageTel: null,
    coopBrokerageSalesperson: null,
    // Form 320's fields, all null: this fixture is a complete Form 100.
    coopBrokerageAddress: null,
    coopBrokerageAddress2: null,
    coopBrokerageFax: null,
    listingBrokerageAddress: null,
    listingBrokerageAddress2: null,
    listingBrokerageFax: null,
    coopCommissionAmount: null,
    coopCommissionTerms: null,
    sellerBrokerageCommentsSingle: null,
    sellerBrokerageCommentsMultiple: null,
    coopBrokerageComments: null,

    // Form 801's fields. All null here: this fixture is a complete Form 100,
    // and the tests that care about 801 fill in what they need.
    offerSubmittedHow: null,
    offerSubmittedTime: null,
    offerSubmittedDate: null,
    counterOfferBuyerNames: null,
    counterOfferSubmittedHow: null,
    counterOfferSubmittedTime: null,
    counterOfferSubmittedDate: null,
    counterOfferIrrevocableTime: null,
    counterOfferIrrevocableDate: null,
    sellerContact: null,
    offerReceivedHow: null,
    offerReceivedTime: null,
    offerReceivedDate: null,
    offerPresentedHow: null,
    offerPresentedTime: null,
    offerPresentedDate: null,
    offerComments: null,

    // Form 371's own terms. Null here on purpose: this fixture is the complete
    // Form 100 deal, and the tests that use it assert on Form 100's blanks.
    designatedRepresentatives: null,
    commencementTime: null,
    commencementDate: null,
    expiryDate: null,
    buyerRequirementsPropertyType: null,
    buyerRequirementsGeographicLocation: null,
    additionalSchedulesList: null,
    commissionPercent: null,
    commissionAlternative: null,
    commissionLease: null,
    holdoverPeriodDays: null,

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
    transaction: { type: 'PURCHASE' },
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
        const result = await check({ transaction: { type: 'PURCHASE' } })

        expect(result.passed).toEqual(false)
        expect(result.failures.length).toBeGreaterThan(40)
    })

    test('agrees with the fill engine about what is missing', async () => {
        const sparse: TransactionSnapshot = { transaction: { type: 'PURCHASE' }, agent }
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
        const result = await check({ transaction: { type: 'PURCHASE' } })

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

    test('a form that names its own required parties is not asked for the others', async () => {
        // Form 371 is signed at onboarding: the buyer engages the brokerage
        // before there is a seller to have an agreement with. The type's table
        // says a PURCHASE needs both sides, and on this form that would report
        // an absent seller against a document with no seller on it.
        const template = await loadTemplate('371')

        expect(template.requiredParties).toEqual(['BUYER'])

        const result = evaluateCompliance(template, {
            ...complete,
            parties: parties.filter(item => item.role === 'BUYER')
        })

        expect(fields(result)).not.toContain('party.seller')
    })

    test('and is still asked for the parties it does name', async () => {
        const result = evaluateCompliance(await loadTemplate('371'), { ...complete, parties: [] })

        expect(fields(result)).toContain('party.buyer')
        expect(fields(result)).not.toContain('party.seller')
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
        expect(fields(result)).toEqual(['agent.brokerage', 'coopBrokerage.name'])
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

        expect(fields(result)).toEqual(['brokerage.phone', 'coopBrokerage.tel'])
    })

    test("on a purchase the agent's own brokerage is fixed on their profile", async () => {
        // The agent acts for the buyer, so the co-operating block is theirs and
        // comes from the profile. Blanking the profile is what makes it missing;
        // the point of the assertion is the *area*, because that is the page the
        // agent is sent to.
        const result = await check({
            ...complete,
            agent: { ...agent, name: '' }
        })

        const salesperson = result.failures.find(
            item => item.field === 'coopBrokerage.salesperson'
        )

        expect(salesperson?.area).toEqual('profile')
        expect(salesperson?.label).toEqual('Co-operating brokerage — salesperson name')
    })

    test('the other side of a purchase is typed in, not taken from the profile', async () => {
        const result = await check({
            ...complete,
            entries: toEntryInput({
                ...entries,
                listingBrokerageName: null,
                listingBrokerageTel: null,
                listingBrokerageSalesperson: null
            })
        })

        const listing = result.failures.find(item => item.field === 'listingBrokerage.name')

        expect(listing?.area).toEqual('entries')
        expect(listing?.label).toEqual('Listing brokerage — brokerage name')

        // The agent's own block is answered by their profile, so it is not a
        // failure however the other side's is filled.
        expect(fields(result)).not.toContain('coopBrokerage.name')
    })

    test('on a listing the blocks swap over', async () => {
        // Listing is not a wired flow — the API refuses to create one. The gate
        // still has to answer correctly for a row that already is one, because
        // pointing an agent at the wrong page is the same mistake as filling the
        // wrong box, one step later.
        const result = await check({
            ...complete,
            transaction: { type: 'LISTING' },
            agent: { ...agent, name: '' },
            entries: toEntryInput({
                ...entries,
                listingBrokerageName: null,
                listingBrokerageTel: null,
                listingBrokerageSalesperson: null
            })
        })

        const salesperson = result.failures.find(
            item => item.field === 'listingBrokerage.salesperson'
        )

        expect(salesperson?.area).toEqual('profile')
        expect(salesperson?.label).toEqual('Listing brokerage — salesperson name')
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

describe('a blank the curation marks optional', () => {
    // Form 801 is the reason this exists: it prints the times the *listing*
    // brokerage received and presented the offer, which the co-operating agent
    // filling the form has no way to know. Without the flag the form could
    // never pass for anybody.
    const emptySummary: TransactionSnapshot = {
        transaction: { type: 'PURCHASE' },
        agent,
        property,
        parties,
        entries: toEntryInput({
            ...entries,
            offerSubmittedHow: 'by email',
            offerSubmittedTime: '4:15 p.m.',
            offerSubmittedDate: '2026-09-02'
        })
    }

    test('is not required, so a form full of them still passes', async () => {
        const result = evaluateCompliance(await loadTemplate('801'), emptySummary)

        expect(fields(result)).toEqual([])
        expect(result.passed).toEqual(true)
    })

    test('but a required blank on the same form is still demanded', async () => {
        // The one thing above that is *not* optional: how and when we sent it.
        const result = evaluateCompliance(await loadTemplate('801'), {
            ...emptySummary,
            entries: toEntryInput(entries)
        })

        expect(result.passed).toEqual(false)
        expect(fields(result)).toContain('offerSubmitted.how')

        // And the optional ones are still absent from the report.
        expect(fields(result)).not.toContain('offerReceived.how')
        expect(fields(result)).not.toContain('offer.comments')
    })

    test('is still a blank an agent may fill, so it keeps its name and label', async () => {
        const template = await loadTemplate('801')

        // `reportableBlankNames` answers "what could be filled", which an
        // optional blank still is. Only the gate treats it differently.
        expect(reportableBlankNames(template)).toContain('offer.comments')
        expect(describeBlank('offer.comments', 'PURCHASE').label).toEqual('Comments')
    })
})

describe('the blanks the gate must never ask for', () => {
    test('no signature or signing-date blank is ever reported', async () => {
        const template = await loadTemplate(FORM)
        const result = await check({ transaction: { type: 'PURCHASE' } })

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
