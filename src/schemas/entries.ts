import { registry, z } from '@/openapi/registry'
import { errorContent } from '@/schemas/common'

/**
 * Entries — the agreement terms the domain model has no other column for
 * (build plan 2.3).
 *
 * Form 100 names 76 data blanks. The field mapper answers 24 of them from the
 * property, the parties and the agent's profile. The remaining 52 are the deal
 * itself, and this is the contract for capturing them.
 *
 * Every field here maps onto blanks `mapper.service.ts` reads. It is not a
 * general-purpose bag: a key the mapper would ignore has no reason to be
 * storable, because it could never appear on a form and could never be
 * checked. The mapper's `entries` input stays open-ended so OCR (2.5) can feed
 * the same object later — this is the shape the *agent* fills, today.
 */

/** Optional free text on a form. Trimmed, bounded, and clearable with null. */
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullish()

/**
 * A calendar date, carried as `YYYY-MM-DD`.
 *
 * Not an instant. A completion date is the date printed on the agreement, and
 * carrying it as a timestamp moves it by a day for anyone reading it west of
 * where it was written.
 */
const dateOnly = z.iso.date()

/**
 * An amount of money, as a decimal string.
 *
 * A string rather than a number, and stored in a `DECIMAL` column, because this
 * figure is drawn onto a contract that people sign. Binary floating point is
 * not a thing to carry a purchase price in, and JSON has no other number.
 *
 * Up to ten digits and at most two decimal places, matching `DECIMAL(12, 2)`.
 * No thousands separators and no currency symbol — the form prints "(CDN$)"
 * beside the blank, and the mapper does the grouping on the way out.
 */
const amount = z
    .string()
    .trim()
    .regex(/^\d{1,10}(\.\d{1,2})?$/, 'An amount is digits with at most two decimal places')

/**
 * One of the form's ruled continuation blocks — chattels, fixtures, rentals.
 *
 * A list of items, one per element, because that is what an agent is writing
 * down. They are joined and flowed across the ruled lines at fill time, where
 * the font metrics are, rather than being stored pre-broken into the lines the
 * form happens to print.
 */
const itemList = z.array(z.string().trim().min(1).max(200)).max(40)

export const transactionEntriesSchema = registry.register(
    'TransactionEntries',
    z.object({
        transactionId: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),

        // "dated this ___ day of ___, 20 ___" on the front page. Schedule A
        // carries the same date and has no field of its own: one agreement, one
        // date, and a schedule dated differently from the agreement it is
        // attached to is a defect.
        agreementDate: dateOnly.nullable().openapi({ example: '2026-09-02' }),

        purchasePrice: amount.nullable().openapi({ example: '1225000.00' }),
        purchasePriceWords: z.string().nullable().openapi({
            description: 'The same figure spelled out. The form prints both, and the words govern.',
            example: 'One Million Two Hundred Twenty-Five Thousand'
        }),

        depositTiming: z.string().nullable().openapi({ example: 'Upon Acceptance' }),
        depositAmount: amount.nullable().openapi({ example: '60000.00' }),
        depositAmountWords: z.string().nullable().openapi({ example: 'Sixty Thousand' }),
        depositHolder: z.string().nullable().openapi({
            description: 'The brokerage holding the deposit in trust.',
            example: 'Realax Realty Inc., Brokerage'
        }),

        schedulesList: z.string().nullable().openapi({
            description: 'Which schedules form part of the agreement.',
            example: 'A'
        }),

        irrevocabilityBoundParty: z.string().nullable().openapi({ example: 'Buyer' }),
        irrevocabilityTime: z.string().nullable().openapi({ example: '11:59 p.m.' }),
        irrevocabilityDate: dateOnly.nullable().openapi({ example: '2026-09-04' }),

        completionDate: dateOnly.nullable().openapi({ example: '2026-11-14' }),
        titleSearchDate: dateOnly.nullable().openapi({ example: '2026-10-24' }),

        // Fax only. The email blanks in the notices block are the parties' own
        // and come from the party records.
        noticesSellerFax: z.string().nullable().openapi({ example: '416-555-0143' }),
        noticesBuyerFax: z.string().nullable().openapi({ example: '416-555-0165' }),

        chattelsIncluded: z.array(z.string()).openapi({ example: ['Refrigerator', 'Stove'] }),
        fixturesExcluded: z.array(z.string()).openapi({ example: ['Dining room chandelier'] }),
        rentalItems: z.array(z.string()).openapi({ example: ['Hot water tank'] }),

        hstTreatment: z.string().nullable().openapi({
            description: 'Whether HST is included in or in addition to the purchase price.',
            example: 'included in'
        }),

        propertyPresentUse: z.string().nullable().openapi({ example: 'Single family residential' }),

        // Both brokerage blocks. The agent's own profile answers whichever one
        // is theirs — the co-operating block on a purchase — and the other side
        // is typed in. A value here beats the profile either way, which is what
        // an agent filing on a colleague's behalf needs.
        listingBrokerageName: z.string().nullable().openapi({
            example: 'Harbourfront Realty Group Ltd., Brokerage'
        }),
        listingBrokerageTel: z.string().nullable().openapi({ example: '416-555-0148' }),
        listingBrokerageSalesperson: z.string().nullable().openapi({ example: 'Dana Whitfield' }),

        coopBrokerageName: z.string().nullable().openapi({
            example: 'Bayview Heights Real Estate Ltd., Brokerage'
        }),
        coopBrokerageTel: z.string().nullable().openapi({ example: '416-555-0173' }),
        coopBrokerageSalesperson: z.string().nullable().openapi({ example: 'Alan Prakash' }),

        // Form 320, the co-operation confirmation.
        coopBrokerageAddress: z.string().nullable().openapi({ example: '55 Yonge Street, Suite 400, Toronto, ON M5E 1J4' }),
        coopBrokerageAddress2: z.string().nullable().openapi({ example: 'Toronto, ON M5E 1J4' }),
        coopBrokerageFax: z.string().nullable().openapi({ example: '416-555-0143' }),
        listingBrokerageAddress: z.string().nullable().openapi({ example: '2900 Bayview Avenue, Unit 12, North York, ON M2K 1E6' }),
        listingBrokerageAddress2: z.string().nullable().openapi({ example: 'North York, ON M2K 1E6' }),
        listingBrokerageFax: z.string().nullable().openapi({ example: '416-555-0174' }),
        coopCommissionAmount: z.string().nullable().openapi({ example: '2.5% of the sale price' }),
        coopCommissionTerms: z.string().nullable().openapi({ example: 'Paid from the deposit on closing.' }),
        sellerBrokerageCommentsSingle: z.string().nullable().openapi({ example: null }),
        sellerBrokerageCommentsMultiple: z.string().nullable().openapi({ example: null }),
        coopBrokerageComments: z.string().nullable().openapi({ example: null }),

        // Form 801, the offer summary. Times of day are the strings the form
        // prints beside "(a.m./p.m.)", not instants.
        offerSubmittedHow: z.string().nullable().openapi({ example: 'by email' }),
        offerSubmittedTime: z.string().nullable().openapi({ example: '4:15 p.m.' }),
        offerSubmittedDate: dateOnly.nullable().openapi({ example: '2026-09-02' }),

        counterOfferBuyerNames: z.string().nullable().openapi({ example: 'Priya Raghunathan' }),
        counterOfferSubmittedHow: z.string().nullable().openapi({ example: 'by email' }),
        counterOfferSubmittedTime: z.string().nullable().openapi({ example: '9:30 a.m.' }),
        counterOfferSubmittedDate: dateOnly.nullable().openapi({ example: '2026-09-03' }),
        counterOfferIrrevocableTime: z.string().nullable().openapi({ example: '11:59 p.m.' }),
        counterOfferIrrevocableDate: dateOnly.nullable().openapi({ example: '2026-09-05' }),

        sellerContact: z.string().nullable().openapi({ example: 'm.whitfield@example.test' }),
        offerReceivedHow: z.string().nullable().openapi({ example: 'by email' }),
        offerReceivedTime: z.string().nullable().openapi({ example: '4:20 p.m.' }),
        offerReceivedDate: dateOnly.nullable().openapi({ example: '2026-09-02' }),
        offerPresentedHow: z.string().nullable().openapi({ example: 'in person' }),
        offerPresentedTime: z.string().nullable().openapi({ example: '7:00 p.m.' }),
        offerPresentedDate: dateOnly.nullable().openapi({ example: '2026-09-02' }),
        offerComments: z.string().nullable().openapi({ example: 'Buyer flexible on closing.' }),

        designatedRepresentatives: z.string().nullable().openapi({ example: 'Darren Fischer' }),
        commencementTime: z.string().nullable().openapi({ example: '9:00 a.m.' }),
        commencementDate: dateOnly.nullable().openapi({ example: '2026-09-01' }),
        expiryDate: dateOnly.nullable().openapi({ example: '2026-12-01' }),
        buyerRequirementsPropertyType: z
            .string()
            .nullable()
            .openapi({ example: 'Detached or semi-detached residential, 3+ bedrooms' }),
        buyerRequirementsGeographicLocation: z
            .string()
            .nullable()
            .openapi({ example: 'City of Toronto, north of Bloor Street' }),
        additionalSchedulesList: z.string().nullable().openapi({ example: null }),
        commissionPercent: z.string().nullable().openapi({ example: '2.5' }),
        commissionAlternative: z.string().nullable().openapi({ example: null }),
        commissionLease: z.string().nullable().openapi({ example: null }),
        holdoverPeriodDays: z.number().int().nullable().openapi({ example: 90 }),

        sellerLawyerName: z.string().nullable().openapi({ example: 'Hollis & Wren LLP' }),
        sellerLawyerAddress: z.string().nullable().openapi({
            example: '120 Adelaide Street West, Suite 900, Toronto, ON M5H 1T1'
        }),
        sellerLawyerEmail: z.string().nullable().openapi({ example: 'conveyancing@holliswren.test' }),
        sellerLawyerTel: z.string().nullable().openapi({ example: '416-555-0107' }),
        sellerLawyerFax: z.string().nullable().openapi({ example: '416-555-0108' }),

        buyerLawyerName: z.string().nullable().openapi({ example: 'Marchetti Law Professional Corporation' }),
        buyerLawyerAddress: z.string().nullable().openapi({
            example: '75 Front Street East, Suite 300, Toronto, ON M5E 1B8'
        }),
        buyerLawyerEmail: z.string().nullable().openapi({ example: 'closings@marchettilaw.test' }),
        buyerLawyerTel: z.string().nullable().openapi({ example: '416-555-0131' }),
        buyerLawyerFax: z.string().nullable().openapi({ example: '416-555-0132' }),

        updatedAt: z.iso.datetime().openapi({ example: '2026-09-02T09:00:00.000Z' })
    })
)

export type TransactionEntries = z.infer<typeof transactionEntriesSchema>

export const transactionEntriesResponseSchema = registry.register(
    'TransactionEntriesResponse',
    z.object({
        entries: transactionEntriesSchema
    })
)

export type TransactionEntriesResponse = z.infer<typeof transactionEntriesResponseSchema>

/**
 * Save the entries on a transaction.
 *
 * A PUT, not a PATCH, matching the property form: the client holds the whole
 * form and sends all of it, so an omitted field is one the agent cleared.
 * Nothing is required — a draft agreement with no price yet is the ordinary
 * state of one, and whether that may proceed is the compliance gate's decision
 * (2.4), not this schema's.
 */
export const saveTransactionEntriesRequestSchema = registry.register(
    'SaveTransactionEntriesRequest',
    z.object({
        agreementDate: dateOnly.nullish().openapi({ example: '2026-09-02' }),

        purchasePrice: amount.nullish().openapi({ example: '1225000.00' }),
        purchasePriceWords: optionalText(200),

        depositTiming: optionalText(120),
        depositAmount: amount.nullish().openapi({ example: '60000.00' }),
        depositAmountWords: optionalText(200),
        depositHolder: optionalText(200),

        schedulesList: optionalText(120),

        irrevocabilityBoundParty: optionalText(60),
        irrevocabilityTime: optionalText(40),
        irrevocabilityDate: dateOnly.nullish(),

        completionDate: dateOnly.nullish(),
        titleSearchDate: dateOnly.nullish(),

        noticesSellerFax: optionalText(40),
        noticesBuyerFax: optionalText(40),

        chattelsIncluded: itemList.optional(),
        fixturesExcluded: itemList.optional(),
        rentalItems: itemList.optional(),

        hstTreatment: optionalText(60),

        propertyPresentUse: optionalText(200),

        listingBrokerageName: optionalText(200),
        listingBrokerageTel: optionalText(40),
        listingBrokerageSalesperson: optionalText(120),

        coopBrokerageName: optionalText(200),
        coopBrokerageTel: optionalText(40),
        coopBrokerageSalesperson: optionalText(120),

        coopBrokerageAddress: optionalText(300),
        coopBrokerageAddress2: optionalText(300),
        coopBrokerageFax: optionalText(40),
        listingBrokerageAddress: optionalText(300),
        listingBrokerageAddress2: optionalText(300),
        listingBrokerageFax: optionalText(40),
        coopCommissionAmount: optionalText(120),
        coopCommissionTerms: optionalText(400),
        sellerBrokerageCommentsSingle: optionalText(400),
        sellerBrokerageCommentsMultiple: optionalText(400),
        coopBrokerageComments: optionalText(400),

        offerSubmittedHow: optionalText(80),
        offerSubmittedTime: optionalText(40),
        offerSubmittedDate: dateOnly.nullish(),

        counterOfferBuyerNames: optionalText(300),
        counterOfferSubmittedHow: optionalText(80),
        counterOfferSubmittedTime: optionalText(40),
        counterOfferSubmittedDate: dateOnly.nullish(),
        counterOfferIrrevocableTime: optionalText(40),
        counterOfferIrrevocableDate: dateOnly.nullish(),

        sellerContact: optionalText(200),
        offerReceivedHow: optionalText(80),
        offerReceivedTime: optionalText(40),
        offerReceivedDate: dateOnly.nullish(),
        offerPresentedHow: optionalText(80),
        offerPresentedTime: optionalText(40),
        offerPresentedDate: dateOnly.nullish(),
        offerComments: optionalText(500),

        designatedRepresentatives: optionalText(200),
        commencementTime: optionalText(40),
        commencementDate: dateOnly.nullish(),
        expiryDate: dateOnly.nullish(),
        buyerRequirementsPropertyType: optionalText(400),
        buyerRequirementsGeographicLocation: optionalText(400),
        additionalSchedulesList: optionalText(200),
        commissionPercent: optionalText(40),
        commissionAlternative: optionalText(300),
        commissionLease: optionalText(300),

        // Days, so an integer — but bounded, because the blank is one short
        // dot-leader run between "within" and "days" and a five-digit holdover
        // is a typo rather than a term.
        holdoverPeriodDays: z.number().int().min(0).max(3650).nullish(),

        sellerLawyerName: optionalText(200),
        sellerLawyerAddress: optionalText(300),
        sellerLawyerEmail: optionalText(200),
        sellerLawyerTel: optionalText(40),
        sellerLawyerFax: optionalText(40),

        buyerLawyerName: optionalText(200),
        buyerLawyerAddress: optionalText(300),
        buyerLawyerEmail: optionalText(200),
        buyerLawyerTel: optionalText(40),
        buyerLawyerFax: optionalText(40)
    })
)

export type SaveTransactionEntriesRequest = z.infer<typeof saveTransactionEntriesRequestSchema>

registry.registerPath({
    method: 'get',
    path: '/api/transactions/{id}/entries',
    summary: "A transaction's agreement terms",
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. A transaction with nothing entered yet answers 200 with every field null rather than 404 — the entries exist as soon as the transaction does, they are simply empty.',
    tags: ['entries'],
    request: {
        params: z.object({
            id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' })
        })
    },
    responses: {
        200: {
            description: 'The saved entries',
            content: { 'application/json': { schema: transactionEntriesResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction')
    }
})

registry.registerPath({
    method: 'put',
    path: '/api/transactions/{id}/entries',
    summary: "Save a transaction's agreement terms",
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. Creates the row on the first call and replaces it in place afterwards. The whole form is sent every time — an absent field clears it.',
    tags: ['entries'],
    request: {
        params: z.object({
            id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' })
        }),
        body: {
            required: true,
            content: { 'application/json': { schema: saveTransactionEntriesRequestSchema } }
        }
    },
    responses: {
        200: {
            description: 'The saved entries',
            content: { 'application/json': { schema: transactionEntriesResponseSchema } }
        },
        400: errorContent('Body failed validation'),
        401: errorContent('No session'),
        404: errorContent('No such transaction')
    }
})
