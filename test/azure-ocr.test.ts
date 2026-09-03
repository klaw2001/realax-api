import type {
    AnalyzeOperationOutput,
    DocumentFieldOutput
} from '@azure-rest/ai-document-intelligence'

import { OcrError } from '../src/integrations/ocr/provider'
import { toScannedIdentity } from '../src/integrations/ocr/azure.client'
import logger from '../src/lib/logger'

// UX plan item 10 — the free development reader.
//
// **Azure is never called here.** The mapping is exercised against responses
// built from the SDK's own `AnalyzeOperationOutput`, exactly as the Textract
// suite is built on `AnalyzeIDResponse`: a change to the vendor's envelope
// becomes a compile error rather than a test that keeps passing against a
// shape the service no longer returns.
//
// What those types do **not** cover is the set of keys inside `fields`. That is
// the model's own schema for `prebuilt-idDocument` and is untyped, so the names
// in `FIELD` are still written from Azure's documentation and are still
// unverified against a real reading. Everything below that does not depend on
// those names — the scaling, the date handling, the address fallback, the
// minimisation — is settled here; the names themselves are settled the first
// time a real Ontario licence goes through, and that is what item 10's
// acceptance is waiting on.

const field = (value: Partial<DocumentFieldOutput>): DocumentFieldOutput =>
    value as DocumentFieldOutput

const analysis = (
    fields: Record<string, DocumentFieldOutput>,
    docType = 'idDocument.driverLicense'
): AnalyzeOperationOutput =>
    ({
        status: 'succeeded',
        createdDateTime: '2026-09-04T09:00:00Z',
        lastUpdatedDateTime: '2026-09-04T09:00:04Z',
        analyzeResult: {
            apiVersion: '2024-11-30',
            modelId: 'prebuilt-idDocument',
            stringIndexType: 'utf16CodeUnit',
            content: '',
            pages: [],
            documents: [{ docType, fields, confidence: 0.98, spans: [] }]
        }
    }) as unknown as AnalyzeOperationOutput

const licence = () =>
    analysis({
        FirstName: field({ valueString: 'MARGARET', confidence: 0.99 }),
        MiddleName: field({ valueString: 'ANNE', confidence: 0.97 }),
        LastName: field({ valueString: 'WHITFIELD', confidence: 0.99 }),
        DocumentNumber: field({ valueString: 'W1234-56789-01234', confidence: 0.9 }),
        DateOfBirth: field({ valueDate: '1979-04-17', confidence: 0.98 }),
        DateOfExpiration: field({ valueDate: '2029-04-17', confidence: 0.98 }),
        DateOfIssue: field({ valueDate: '2024-04-17', confidence: 0.98 }),
        Address: field({
            content: '18 MAPLE GROVE AVE TORONTO ON M4K 2R7',
            confidence: 0.95,
            valueAddress: {
                streetAddress: '18 MAPLE GROVE AVE',
                city: 'TORONTO',
                state: 'ON',
                postalCode: 'M4K 2R7'
            }
        })
    })

describe('an Azure response becomes a scanned identity', () => {
    test('every field the product has a use for', () => {
        const scan = toScannedIdentity(licence(), 'drivers_licence')

        expect(scan.firstName).toEqual('MARGARET')
        expect(scan.middleName).toEqual('ANNE')
        expect(scan.lastName).toEqual('WHITFIELD')
        expect(scan.fullName).toEqual('MARGARET ANNE WHITFIELD')
        expect(scan.documentNumber).toEqual('W1234-56789-01234')
        expect(scan.dateOfBirth).toEqual('1979-04-17')
        expect(scan.expiryDate).toEqual('2029-04-17')
        expect(scan.dateOfIssue).toEqual('2024-04-17')
        expect(scan.address).toEqual('18 MAPLE GROVE AVE')
        expect(scan.city).toEqual('TORONTO')
        expect(scan.province).toEqual('ON')
        expect(scan.postalCode).toEqual('M4K 2R7')
        expect(scan.provider).toEqual('azure')
        expect(scan.modelVersion).toEqual('2024-11-30')
    })

    test('confidence is the domain’s 0–100, not Azure’s 0–1', () => {
        // The two readers score on different scales and `confidence` has to
        // mean one thing whichever produced it — a 0.9 reaching the frontend
        // unscaled would read as "check every field" on a good reading.
        const scan = toScannedIdentity(licence(), 'drivers_licence')

        expect(scan.confidence).toBeCloseTo(90)
    })

    test('the lowest score wins, and the address counts toward it', () => {
        const weakAddress = licence()
        const fields = weakAddress.analyzeResult!.documents![0].fields!

        fields.Address = field({ ...fields.Address, confidence: 0.4 })

        expect(toScannedIdentity(weakAddress, 'drivers_licence').confidence).toBeCloseTo(40)
    })

    test('a date the model could not normalise is left blank, never guessed', () => {
        // 03/04/1985 is two different birthdays depending on where the card was
        // issued. A blank the agent fills is better than a record wrong by a
        // month.
        const ambiguous = analysis({
            DateOfBirth: field({ content: '03/04/1985', confidence: 0.99 })
        })

        expect(toScannedIdentity(ambiguous, 'drivers_licence').dateOfBirth).toBeNull()
    })

    test('an unparsed address still fills the street line', () => {
        const printed = analysis({
            Address: field({ content: '18 MAPLE GROVE AVE TORONTO ON M4K 2R7', confidence: 0.8 })
        })

        const scan = toScannedIdentity(printed, 'drivers_licence')

        expect(scan.address).toEqual('18 MAPLE GROVE AVE TORONTO ON M4K 2R7')
        expect(scan.city).toBeNull()
        expect(scan.province).toBeNull()
        expect(scan.postalCode).toBeNull()
    })

    test('what the card is, read from the model rather than from the agent', () => {
        expect(
            toScannedIdentity(analysis({}, 'idDocument.passport'), 'drivers_licence').documentType
        ).toEqual('passport')

        expect(
            toScannedIdentity(analysis({}, 'idDocument.driverLicense'), 'passport').documentType
        ).toEqual('drivers_licence')

        // Something the model names and we do not accept: the agent's
        // declaration stands, and the service decides what to do about it.
        expect(
            toScannedIdentity(analysis({}, 'idDocument.residencePermit'), 'passport').documentType
        ).toEqual('passport')
    })

    test('nothing is kept that no form and no FINTRAC method asks for', () => {
        const chatty = analysis({
            FirstName: field({ valueString: 'MARGARET', confidence: 0.99 }),
            Height: field({ valueString: '170 cm', confidence: 0.99 }),
            EyeColor: field({ valueString: 'BRO', confidence: 0.99 }),
            Endorsements: field({ valueString: 'NONE', confidence: 0.99 }),
            VehicleClassifications: field({ valueString: 'G', confidence: 0.99 })
        })

        const scan = toScannedIdentity(chatty, 'drivers_licence')

        // Reading a field because a vendor returned it is how a system ends up
        // holding data it cannot justify.
        expect(JSON.stringify(scan)).not.toContain('170 cm')
        expect(JSON.stringify(scan)).not.toContain('BRO')
        expect(Object.keys(scan).sort()).toEqual(
            [
                'address',
                'city',
                'confidence',
                'dateOfBirth',
                'dateOfIssue',
                'documentNumber',
                'documentType',
                'expiryDate',
                'firstName',
                'fullName',
                'lastName',
                'middleName',
                'modelVersion',
                'postalCode',
                'province',
                'provider'
            ].sort()
        )
    })

    test('the field names are reported, and the values are not', () => {
        // The mapping cannot be confirmed without a real reading, so the first
        // one has to say what it saw. Names only: a licence number in a log
        // line is what rule 6 exists to prevent.
        const logged: unknown[] = []
        const spy = jest.spyOn(logger, 'info').mockImplementation(((...args: unknown[]) => {
            logged.push(args)

            return logger
        }) as never)

        const chatty = analysis({
            FirstName: field({ valueString: 'MARGARET', confidence: 0.99 }),
            EyeColor: field({ valueString: 'BRO', confidence: 0.99 })
        })

        toScannedIdentity(chatty, 'drivers_licence')

        const line = JSON.stringify(logged)

        expect(line).toContain('firstName')
        expect(line).toContain('EyeColor')
        expect(line).not.toContain('MARGARET')
        expect(line).not.toContain('BRO')

        spy.mockRestore()
    })

    test('a field the model named but read nothing into is not a field', () => {
        const blanks = analysis({
            FirstName: field({ valueString: '   ', confidence: 0.99 }),
            LastName: field({ valueString: 'WHITFIELD', confidence: 0.99 })
        })

        const scan = toScannedIdentity(blanks, 'drivers_licence')

        expect(scan.firstName).toBeNull()
        expect(scan.fullName).toEqual('WHITFIELD')
    })

    test('no document in the image is unreadable, which is the agent’s to fix', () => {
        const empty = analysis({})

        empty.analyzeResult!.documents = []

        const error = (() => {
            try {
                toScannedIdentity(empty, 'drivers_licence')
            } catch (thrown) {
                return thrown
            }

            return null
        })()

        expect(error).toBeInstanceOf(OcrError)
        expect((error as OcrError).kind).toEqual('unreadable')
    })
})
