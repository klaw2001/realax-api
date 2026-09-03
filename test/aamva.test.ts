import { looksLikeAamva, parseAamva } from '../src/integrations/ocr/aamva'

/**
 * The PDF417 barcode on the back of a licence, parsed (UX plan item 10).
 *
 * Worth testing hard, because unlike every other reader in this system there is
 * no confidence and no second opinion: whatever comes out of here is recorded
 * as what the issuing authority wrote. The failure mode is not "a field is
 * slightly wrong" but "a date of birth is off by ten months because the country
 * was assumed".
 *
 * Getting the barcode *out of a photograph* is not tested here and cannot be —
 * zxing-js ships no PDF417 encoder, so there is no way to synthesise one. That
 * half needs a photograph of a real card.
 */

/** An Ontario licence's barcode, in the shape a decoder returns it. */
const ontario = [
    'ANSI 636012080102DL00410278ZO03190008DL',
    'DCSWHITFIELD',
    'DACMARGARET',
    'DADANNE',
    'DBB19790417',
    'DBA20290417',
    'DBD20240417',
    'DAQW12345678901234',
    'DAG18 MAPLE GROVE AVE',
    'DAITORONTO',
    'DAJON',
    'DAKM4K2R7    ',
    'DCGCAN',
    'DAU070 IN',
    'DAYBRO',
    'DCAG'
].join('\n')

/** A minimal record: the licence number, plus whatever the test is about. */
const record = (...lines: string[]) => ['ANSI 6360120801', 'DAQ12345', ...lines].join('\n')

describe('recognising a licence barcode', () => {
    test('an AAMVA record is recognised', () => {
        expect(looksLikeAamva(ontario)).toBe(true)
    })

    test('a barcode off something else is not', () => {
        expect(looksLikeAamva('https://example.com/loyalty/12345')).toBe(false)
        expect(parseAamva('https://example.com/loyalty/12345', 'drivers_licence')).toBeNull()
    })

    test('an AAMVA-shaped record with no licence number is not a document we can record', () => {
        const withoutNumber = ontario
            .split('\n')
            .filter(line => !line.startsWith('DAQ'))
            .join('\n')

        expect(parseAamva(withoutNumber, 'drivers_licence')).toBeNull()
    })
})

describe('an Ontario licence', () => {
    const scan = parseAamva(ontario, 'drivers_licence')

    test('yields the fields the product uses', () => {
        expect(scan?.firstName).toEqual('MARGARET')
        expect(scan?.middleName).toEqual('ANNE')
        expect(scan?.lastName).toEqual('WHITFIELD')
        expect(scan?.fullName).toEqual('MARGARET ANNE WHITFIELD')
        expect(scan?.documentNumber).toEqual('W12345678901234')
        expect(scan?.address).toEqual('18 MAPLE GROVE AVE')
        expect(scan?.city).toEqual('TORONTO')
        expect(scan?.province).toEqual('ON')
    })

    test('reads Canadian dates as CCYYMMDD', () => {
        expect(scan?.dateOfBirth).toEqual('1979-04-17')
        expect(scan?.expiryDate).toEqual('2029-04-17')
        expect(scan?.dateOfIssue).toEqual('2024-04-17')
    })

    test('prints the postal code the way a person writes it', () => {
        // Encoded as M4K2R7 and padded to the standard's width.
        expect(scan?.postalCode).toEqual('M4K 2R7')
    })

    test('reports certainty, because nothing was recognised', () => {
        // This is not OCR. The text was written by the issuing authority and is
        // read back verbatim — either the barcode decoded or it did not.
        expect(scan?.confidence).toEqual(100)
        expect(scan?.provider).toEqual('barcode')
    })

    test('keeps nothing the forms and FINTRAC do not ask for', () => {
        const serialised = JSON.stringify(scan)

        // Height and eye colour are in the barcode and are none of our business.
        expect(serialised).not.toContain('070 IN')
        expect(serialised).not.toContain('BRO')
    })
})

describe('the two date formats, which are the dangerous part', () => {
    const withCountry = (country: string, date: string) =>
        parseAamva(record(`DBB${date}`, `DCG${country}`), 'drivers_licence')

    test('the same eight digits mean different days in Canada and the US', () => {
        expect(withCountry('CAN', '19790417')?.dateOfBirth).toEqual('1979-04-17')
        expect(withCountry('USA', '04171979')?.dateOfBirth).toEqual('1979-04-17')
    })

    test('a US record is not read as Canadian', () => {
        // 12251985 is Christmas Day 1985 read as MMDDCCYY. Read as CCYYMMDD it
        // would be the year 1225, which is not a date on a licence.
        expect(withCountry('USA', '12251985')?.dateOfBirth).toEqual('1985-12-25')
        expect(withCountry('CAN', '12251985')?.dateOfBirth).toBeNull()
    })

    test('with no country, an unambiguous reading is taken', () => {
        // 19790417 as MMDDCCYY would be month 19, which is not a month — so
        // only one reading is a real date and it can be trusted.
        expect(parseAamva(record('DBB19790417'), 'drivers_licence')?.dateOfBirth).toEqual('1979-04-17')
    })

    test('with no country and two valid readings, nothing is guessed', () => {
        // 10121012 is a real date both ways: 1012-10-12 either way round.
        // A record wrong by ten months is worse than a blank the agent fills.
        expect(parseAamva(record('DBB10121012'), 'drivers_licence')?.dateOfBirth).toBeNull()
    })

    test('a date that is not eight digits is left alone', () => {
        expect(withCountry('CAN', '')?.dateOfBirth).toBeNull()
        expect(withCountry('CAN', '1979')?.dateOfBirth).toBeNull()
    })
})

describe('what the standard calls an absence', () => {
    test('NONE is not a middle name', () => {
        const none = parseAamva(record('DACMARGARET', 'DADNONE', 'DCSWHITFIELD'), 'drivers_licence')

        expect(none?.middleName).toBeNull()
        expect(none?.fullName).toEqual('MARGARET WHITFIELD')
    })
})

describe('a barcode read while a passport was declared', () => {
    test('is reported as the licence it actually is, and says so', () => {
        const scan = parseAamva(ontario, 'passport')

        // A passport carries a machine readable zone, not a PDF417. What the
        // barcode is is not a matter of opinion, so the disagreement is
        // recorded rather than resolved here.
        expect(scan?.documentType).toEqual('drivers_licence')
        expect(scan?.modelVersion).toContain('type-mismatch')
    })
})
