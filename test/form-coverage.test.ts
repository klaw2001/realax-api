import { describeBlank, evaluateCompliance } from '../src/modules/compliance/compliance.service'
import { toEntryInput } from '../src/modules/entries/entries.service'
import type { TransactionSnapshot } from '../src/modules/forms/mapper.service'
import { listTemplateCodes, loadTemplate, reportableBlankNames } from '../src/modules/forms/template.service'
import type { AgentProfile } from '../src/schemas/agent'
import type { TransactionEntries, SaveTransactionEntriesRequest } from '../src/schemas/entries'
import type { Party } from '../src/schemas/party'
import type { Property } from '../src/schemas/property'

// Coverage guards. Unit tests: no database, no S3, no network.
//
// Every curated form has to be *reachable* — every blank it names must have
// something that can fill it — and *legible* — every blank it reports must have
// a label a person can act on. Neither property is checked anywhere else, and
// both are easy to break silently:
//
//   - a column reaches the mapper only if it is written into all five lists in
//     `entries.service.ts`, and nothing type-checks those lists against each
//     other. Miss one and the value is stored, returned to the client, and
//     never drawn.
//   - `describeBlank` falls back to the raw blank name when a form names a
//     blank `BLANK_LABELS` does not. That fallback is deliberate — it keeps a
//     newly curated form legible while its labels are being written — but
//     shipping it hands an agent our internal dot-path as their to-do item.
//
// Both tests loop over `listTemplateCodes()` rather than a list written here,
// so curating a new form opts it in without touching this file.

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

/**
 * Every entries field, with something in it.
 *
 * Typed `Required<…>` on purpose, and that annotation is load-bearing: it is
 * what makes adding a column to the API without adding it here a *compile*
 * error rather than a test that quietly stops covering it. Do not loosen it to
 * `Partial` or to the plain request type to make a new column build.
 */
const FULL_ENTRIES: Required<SaveTransactionEntriesRequest> = {
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
    listingBrokerageName: 'Harbourfront Realty Group Ltd., Brokerage',
    listingBrokerageTel: '416-555-0148',
    listingBrokerageSalesperson: 'Dana Whitfield',
    coopBrokerageName: 'Bayview Heights Real Estate Ltd., Brokerage',
    coopBrokerageTel: '416-555-0173',
    coopBrokerageSalesperson: 'Alan Prakash',
    coopBrokerageAddress: '55 Yonge Street, Suite 400',
    coopBrokerageAddress2: 'Toronto, ON M5E 1J4',
    coopBrokerageFax: '416-555-0143',
    listingBrokerageAddress: '2900 Bayview Avenue, Unit 12',
    listingBrokerageAddress2: 'North York, ON M2K 1E6',
    listingBrokerageFax: '416-555-0174',
    coopCommissionAmount: '2.5% of the sale price',
    coopCommissionTerms: 'Paid from the deposit held in trust on completion.',
    sellerBrokerageCommentsSingle: 'None.',
    sellerBrokerageCommentsMultiple: 'None.',
    coopBrokerageComments: 'None.',
    offerSubmittedHow: 'by email',
    offerSubmittedTime: '4:15 p.m.',
    offerSubmittedDate: '2026-09-02',
    counterOfferBuyerNames: 'Priya Raghunathan',
    counterOfferSubmittedHow: 'by email',
    counterOfferSubmittedTime: '9:30 a.m.',
    counterOfferSubmittedDate: '2026-09-03',
    counterOfferIrrevocableTime: '11:59 p.m.',
    counterOfferIrrevocableDate: '2026-09-05',
    sellerContact: 'm.whitfield@example.test',
    offerReceivedHow: 'by email',
    offerReceivedTime: '4:20 p.m.',
    offerReceivedDate: '2026-09-02',
    offerPresentedHow: 'in person',
    offerPresentedTime: '7:00 p.m.',
    offerPresentedDate: '2026-09-02',
    offerComments: 'Buyer is flexible on the closing date.',
    designatedRepresentatives: 'Alan Prakash',
    commencementTime: '9:00 a.m.',
    commencementDate: '2026-08-01',
    expiryDate: '2026-12-01',
    buyerRequirementsPropertyType: 'Detached or semi-detached residential, 3+ bedrooms',
    buyerRequirementsGeographicLocation: 'City of Toronto, north of Bloor Street',
    additionalSchedulesList: 'B',
    commissionPercent: '2.5',
    commissionAlternative: 'A flat fee of $18,000.00 plus applicable taxes.',
    commissionLease: 'One month of the gross rent, plus applicable taxes.',
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

/**
 * The request shape as a stored row.
 *
 * `toEntryInput` reads a `TransactionEntries` — the row plus its id and
 * timestamp, which the mapper never looks at. Adding them here rather than
 * carrying a second full fixture keeps one place to edit when a column lands.
 */
const storedEntries: TransactionEntries = {
    ...FULL_ENTRIES,
    transactionId: 'tx_1',
    updatedAt: '2026-09-02T09:00:00.000Z'
}

const complete: TransactionSnapshot = {
    transaction: { type: 'PURCHASE' },
    agent,
    property,
    parties,
    entries: toEntryInput(storedEntries)
}

describe('every curated form', () => {
    test('has at least one form to check', async () => {
        // A guard on the guards: if the templates directory were empty or the
        // filter were wrong, both tests below would loop zero times and pass
        // while checking nothing.
        expect((await listTemplateCodes()).length).toBeGreaterThan(0)
    })

    test('can be filled from a fully populated transaction', async () => {
        for (const code of await listTemplateCodes()) {
            const result = evaluateCompliance(await loadTemplate(code), complete)

            // Named in the message because a bare `false` on a loop over four
            // forms says nothing about which one, or which blank.
            expect({ code, failures: result.failures.map(failure => failure.field) }).toEqual({
                code,
                failures: []
            })
        }
    })

    test('reports every blank with a label rather than its internal name', async () => {
        for (const code of await listTemplateCodes()) {
            const template = await loadTemplate(code)

            const unlabelled = reportableBlankNames(template).filter(
                name => describeBlank(name, 'PURCHASE').label === name
            )

            expect({ code, unlabelled }).toEqual({ code, unlabelled: [] })
        }
    })
})
