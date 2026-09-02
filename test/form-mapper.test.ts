import {
    buildMergedValues,
    mapTemplateValues,
    mapTransactionToTemplate,
    splitFormDate,
    type TransactionSnapshot
} from '../src/modules/forms/mapper.service'
import { dataBlanks, loadTemplate } from '../src/modules/forms/template.service'
import type { AgentProfile } from '../src/schemas/agent'
import type { Party } from '../src/schemas/party'
import type { Property } from '../src/schemas/property'

// Build plan 2.2. Unit tests: no database, no S3, no network. The mapper is a
// pure function of a snapshot, which is the reason it is one — the fill engine
// and the compliance gate both depend on this object being predictable.

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
        address: '200 Bay St, Toronto',
        phone: '416-555-0100'
    }
}

const property: Property = {
    id: 'property_1',
    mlsNumber: 'C5839471',
    address: '88 Wellesley St E',
    city: 'Toronto',
    province: 'ON',
    postalCode: 'M4Y 1H1',
    frontingSide: 'North',
    frontingStreet: 'Wellesley Street East',
    frontage: '49.21 feet',
    depth: '120 feet',
    legalDescription: 'LOT 7 BLK G PLAN 66M-1234',
    listPrice: 1250000,
    taxes: '4,231.00'
}

const party = (overrides: Partial<Party> & Pick<Party, 'fullLegalName' | 'role'>): Party => ({
    id: `tp_${overrides.fullLegalName}`,
    personId: `person_${overrides.fullLegalName}`,
    signingOrder: null,
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
        fullLegalName: 'Margaret Anne Chen',
        role: 'SELLER',
        signingOrder: 1,
        email: 'm.chen@example.com',
        phone: '416-555-0142',
        address: '88 Wellesley St E',
        city: 'Toronto',
        province: 'ON',
        postalCode: 'M4Y 1H1'
    }),
    party({ fullLegalName: 'David Chen', role: 'SELLER', signingOrder: 2 }),
    party({
        fullLegalName: 'Priya Raman',
        role: 'BUYER',
        signingOrder: 3,
        email: 'p.raman@example.com',
        phone: '647-555-0119',
        address: '19 Palmerston Ave',
        city: 'Toronto',
        province: 'ON',
        postalCode: 'M6J 2H8'
    })
]

/**
 * Everything Form 100 asks for that no column holds: price, dates, deposit
 * terms, chattels, lawyers, the other side's brokerage. Written the way the
 * capture form will send it — nested, dates as `YYYY-MM-DD`, money as numbers.
 */
const entries = {
    agreement: { date: '2026-09-02' },
    purchasePrice: 1250000,
    'purchasePrice.words': 'One Million Two Hundred Fifty Thousand',
    deposit: {
        timing: 'Upon Acceptance',
        amount: 50000,
        amountWords: 'Fifty Thousand',
        holder: 'Realax Realty Inc., Brokerage'
    },
    schedules: { list: 'A' },
    irrevocability: { boundParty: 'Buyer', time: '5:00 p.m.', date: '2026-09-04' },
    completion: { date: '2026-11-30' },
    titleSearch: { date: '2026-10-15' },
    notices: { buyerFax: '647-555-0120', sellerFax: '416-555-0143' },
    chattelsIncluded: ['Refrigerator', 'Stove', 'Dishwasher', 'Window coverings'],
    fixturesExcluded: ['Dining room chandelier', 'Garage shelving', 'None', 'None'],
    rentalItems: ['Hot water tank', 'None', 'None'],
    hst: { treatment: 'included in' },
    property: { presentUse: 'Residential' },
    coopBrokerage: {
        name: 'Bayview Realty Ltd., Brokerage',
        tel: '416-555-0170',
        salesperson: 'Alan Whitfield'
    },
    sellerLawyer: {
        name: 'Ruth Okafor',
        address: '55 King St W, Toronto',
        email: 'r.okafor@example.com',
        tel: '416-555-0161',
        fax: '416-555-0162'
    },
    buyerLawyer: {
        name: 'Tomas Lindqvist',
        address: '120 Adelaide St W, Toronto',
        email: 't.lindqvist@example.com',
        tel: '416-555-0163',
        fax: '416-555-0164'
    }
}

const fullSnapshot: TransactionSnapshot = {
    transaction: { type: 'LISTING' },
    agent,
    property,
    parties,
    entries
}

describe('a fully populated transaction', () => {
    test('produces a value for every data blank Form 100 names', async () => {
        const template = await loadTemplate(FORM)
        const values = mapTransactionToTemplate(template, fullSnapshot)

        const empty = dataBlanks(template)
            .filter(blank => values[blank.name] === undefined)
            .map(blank => blank.name)

        expect(empty).toEqual([])
        expect(dataBlanks(template)).toHaveLength(76)
    })

    test('maps the domain model onto the blanks the form gives them', async () => {
        const values = mapTransactionToTemplate(await loadTemplate(FORM), fullSnapshot)

        expect(values['seller.fullLegalNames']).toEqual('Margaret Anne Chen and David Chen')
        expect(values['buyer.fullLegalNames']).toEqual('Priya Raman')
        expect(values['property.address']).toEqual('88 Wellesley St E')
        expect(values['property.municipality']).toEqual('Toronto')
        expect(values['property.frontingSide']).toEqual('North')
        expect(values['notices.sellerEmail']).toEqual('m.chen@example.com')
        expect(values['seller.addressForService.line1']).toEqual('88 Wellesley St E')
        expect(values['seller.addressForService.line2']).toEqual('Toronto ON M4Y 1H1')
        expect(values['seller.addressForService.tel']).toEqual('416-555-0142')

        // Schedule A repeats the front page rather than being captured twice.
        expect(values['scheduleA.seller.fullLegalNames']).toEqual(values['seller.fullLegalNames'])
        expect(values['scheduleA.property.line1']).toEqual('88 Wellesley St E')
        expect(values['scheduleA.property.line2']).toEqual('Toronto ON M4Y 1H1')
    })

    test('puts the agent on the side of the deal they are acting for', async () => {
        const template = await loadTemplate(FORM)

        const listing = mapTransactionToTemplate(template, fullSnapshot)
        expect(listing['listingBrokerage.name']).toEqual('Realax Realty Inc., Brokerage')
        expect(listing['listingBrokerage.tel']).toEqual('416-555-0100')
        expect(listing['listingBrokerage.salesperson']).toEqual('Darren Fischer')

        // The same agent on a purchase is the co-operating brokerage. Filling
        // the listing box there would put the buyer's agent on the seller's
        // line of a document both lawyers read.
        const purchase = mapTransactionToTemplate(template, {
            ...fullSnapshot,
            transaction: { type: 'PURCHASE' },
            entries: { ...entries, coopBrokerage: undefined }
        })
        expect(purchase['coopBrokerage.name']).toEqual('Realax Realty Inc., Brokerage')
        expect(purchase['coopBrokerage.salesperson']).toEqual('Darren Fischer')
        expect(purchase['listingBrokerage.name']).toBeUndefined()
    })

    test('splits the dates and formats the money the way the form prints them', async () => {
        const values = mapTransactionToTemplate(await loadTemplate(FORM), fullSnapshot)

        expect(values['agreement.dateDay']).toEqual('2')
        expect(values['agreement.dateMonth']).toEqual('September')

        // Two digits: the century is preprinted beside the blank.
        expect(values['agreement.dateYear']).toEqual('26')

        expect(values['completion.dateMonth']).toEqual('November')
        expect(values['titleSearch.dateDay']).toEqual('15')
        expect(values['irrevocability.dateDay']).toEqual('4')

        // Schedule A carries the agreement's own date.
        expect(values['scheduleA.dateMonth']).toEqual('September')
        expect(values['scheduleA.dateYear']).toEqual('26')

        expect(values['purchasePrice.numeric']).toEqual('1,250,000.00')
        expect(values['deposit.amountNumeric']).toEqual('50,000.00')
    })

    test('spreads a list across the numbered lines the form gives it', async () => {
        const values = mapTransactionToTemplate(await loadTemplate(FORM), fullSnapshot)

        expect(values['chattelsIncluded.line1']).toEqual('Refrigerator')
        expect(values['chattelsIncluded.line4']).toEqual('Window coverings')
        expect(values['rentalItems.line1']).toEqual('Hot water tank')
    })
})

describe('a sparse transaction', () => {
    const empty: TransactionSnapshot = { transaction: { type: 'LISTING' } }

    test('names every blank on the form and leaves the rest undefined', async () => {
        const template = await loadTemplate(FORM)
        const values = mapTransactionToTemplate(template, empty)

        expect(Object.keys(values).sort()).toEqual(template.blanks.map(b => b.name).sort())

        for (const blank of template.blanks) {
            expect(values[blank.name]).toBeUndefined()
        }
    })

    test('fills what it has and asks nothing of what it does not', async () => {
        const values = mapTransactionToTemplate(await loadTemplate(FORM), {
            transaction: { type: 'LISTING' },
            parties: [party({ fullLegalName: 'Margaret Anne Chen', role: 'SELLER' })]
        })

        expect(values['seller.fullLegalNames']).toEqual('Margaret Anne Chen')
        expect(values['buyer.fullLegalNames']).toBeUndefined()
        expect(values['property.address']).toBeUndefined()
        expect(values['purchasePrice.numeric']).toBeUndefined()

        // A partly-filled snapshot is a normal state, not an error: the gate in
        // 2.4 is what reports it, and it can only do that if this returned.
        expect(() =>
            buildMergedValues({ transaction: { type: 'LISTING' }, entries: {} })
        ).not.toThrow()
    })
})

describe('the merged object', () => {
    test('takes what the agent typed over what the domain model holds', () => {
        const values = buildMergedValues({
            ...fullSnapshot,
            entries: {
                ...entries,
                property: { ...entries.property, address: 'Unit 4, 88 Wellesley St E' },
                'seller.addressForService.line1': 'c/o Okafor Law, 55 King St W'
            }
        })

        expect(values['property.address']).toEqual('Unit 4, 88 Wellesley St E')
        expect(values['seller.addressForService.line1']).toEqual('c/o Okafor Law, 55 King St W')

        // Still the domain value where nothing was typed over it.
        expect(values['property.municipality']).toEqual('Toronto')
    })

    test('reads dot-pathed and nested entries as the same thing', () => {
        const nested = buildMergedValues({
            transaction: { type: 'LISTING' },
            entries: { hst: { treatment: 'included in' } }
        })
        const dotted = buildMergedValues({
            transaction: { type: 'LISTING' },
            entries: { 'hst.treatment': 'included in' }
        })

        expect(nested['hst.treatment']).toEqual('included in')
        expect(dotted['hst.treatment']).toEqual(nested['hst.treatment'])
    })

    test('treats blank and unprintable entries as nothing to draw', () => {
        const values = buildMergedValues({
            transaction: { type: 'LISTING' },
            property,
            entries: {
                'property.address': '   ',
                'hst.treatment': null,
                'deposit.holder': false,
                'schedules.list': 0
            }
        })

        // A whitespace-only entry does not blank out the property it was typed
        // over, and does not count as a satisfied blank either.
        expect(values['property.address']).toEqual('88 Wellesley St E')
        expect(values['hst.treatment']).toBeUndefined()
        expect(values['deposit.holder']).toBeUndefined()
        expect(values['schedules.list']).toEqual('0')
    })

    test('keeps a deposit term that is a phrase rather than a figure', () => {
        const values = buildMergedValues({
            transaction: { type: 'LISTING' },
            entries: { deposit: { amount: 'to be determined' } }
        })

        expect(values['deposit.amountNumeric']).toEqual('to be determined')
    })
})

describe('projecting onto a template', () => {
    test('never draws a signature or a signing date', async () => {
        const template = await loadTemplate(FORM)

        // Even asked to directly: a signature drawn before anyone signed is a
        // forged document, and those blanks are filled in the e-sign session.
        const values = mapTemplateValues(template, {
            'execution.buyer1.signature': 'Priya Raman',
            'acceptance.dateDay': '2',
            'property.address': '88 Wellesley St E'
        })

        expect(values['execution.buyer1.signature']).toBeUndefined()
        expect(values['acceptance.dateDay']).toBeUndefined()
        expect(values['property.address']).toEqual('88 Wellesley St E')
    })

    test('drops values the form does not ask for', async () => {
        const template = await loadTemplate(FORM)
        const values = mapTemplateValues(template, { 'someOtherForm.field': 'x' })

        expect(values).not.toHaveProperty('someOtherForm.field')
    })
})

describe('splitFormDate', () => {
    test('reads a calendar date in UTC, whatever the server timezone is', () => {
        expect(splitFormDate('2026-01-01')).toEqual({ day: '1', month: 'January', year: '26' })
        expect(splitFormDate('2026-09-02T23:30:00.000Z')).toEqual({
            day: '2',
            month: 'September',
            year: '26'
        })
    })

    test('refuses anything that is not one', () => {
        expect(splitFormDate('September 2, 2026')).toBeUndefined()
        expect(splitFormDate('2026-13-02')).toBeUndefined()
        expect(splitFormDate('')).toBeUndefined()
        expect(splitFormDate(undefined)).toBeUndefined()
    })
})
