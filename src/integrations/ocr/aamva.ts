import type { IdentityDocumentType, ScannedIdentity } from '@/integrations/ocr/provider'

/**
 * The PDF417 barcode on the back of a driver's licence, decoded.
 *
 * **This is not OCR.** An Ontario licence carries an AAMVA-standard PDF417
 * barcode holding the name, date of birth, address, licence number, issue and
 * expiry as *encoded text*. Nothing is being recognised from an image of
 * printed characters — the fields were written by the issuing authority and
 * come back exactly as they were written. There is no confidence to report and
 * no field to misread.
 *
 * That makes it more accurate than any of the OCR options, free forever,
 * offline, and residency-safe in a way no vendor can be: the document never
 * leaves the process. Its one limitation is real — it needs a photograph of the
 * **back** of the card, and a front-only photo yields nothing at all.
 *
 * Parsing is separated from decoding on purpose. Getting a barcode out of a
 * photograph is the part that fails on a bad angle or poor light; turning the
 * string it produces into our vocabulary is deterministic and is tested as
 * such.
 */

/**
 * The AAMVA element ids this product has a use for.
 *
 * Deliberately short. The standard defines dozens more — height, weight, eye
 * colour, hair colour, endorsements, vehicle class, organ donor status — and
 * no OREA form or FINTRAC method asks for any of them. Reading a field because
 * it happens to be in the barcode is how a system ends up holding data it
 * cannot justify.
 */
const ELEMENT = {
    DCS: 'lastName',
    DAC: 'firstName',
    DAD: 'middleName',
    DBB: 'dateOfBirth',
    DBA: 'expiryDate',
    DBD: 'dateOfIssue',
    DAQ: 'documentNumber',
    DAG: 'address',
    DAI: 'city',
    DAJ: 'province',
    DAK: 'postalCode',
    DCG: 'country'
} as const

type Element = (typeof ELEMENT)[keyof typeof ELEMENT]

/** `NONE` is how the standard says "there isn't one", and it is not a value. */
const clean = (value: string | undefined): string | null => {
    const trimmed = value?.trim() ?? ''

    return trimmed === '' || trimmed.toUpperCase() === 'NONE' ? null : trimmed
}

/**
 * An AAMVA date, which is two different formats depending on the country.
 *
 * `CCYYMMDD` in Canada, `MMDDCCYY` in the United States — the same eight digits
 * meaning different things, which is exactly the kind of ambiguity a date of
 * birth cannot afford. The country element decides it; without one, an
 * unambiguous reading is attempted and anything else is left null rather than
 * guessed, because a FINTRAC record wrong by a month is worse than a blank.
 */
const parseDate = (value: string | null, country: string | null): string | null => {
    if (value === null || !/^\d{8}$/.test(value)) {
        return null
    }

    const asCanadian = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    const asAmerican = `${value.slice(4, 8)}-${value.slice(0, 2)}-${value.slice(2, 4)}`

    if (country === 'CAN') {
        return valid(asCanadian) ? asCanadian : null
    }

    if (country === 'USA') {
        return valid(asAmerican) ? asAmerican : null
    }

    // No country element. Only one reading being a real date settles it; both
    // being real is genuinely ambiguous and is answered with nothing.
    const canadian = valid(asCanadian)
    const american = valid(asAmerican)

    if (canadian && !american) {
        return asCanadian
    }

    if (american && !canadian) {
        return asAmerican
    }

    return null
}

/** Whether `YYYY-MM-DD` names a day that exists. */
const valid = (date: string): boolean => {
    const [year, month, day] = date.split('-').map(Number)

    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
        return false
    }

    const at = new Date(`${date}T00:00:00.000Z`)

    return !Number.isNaN(at.getTime()) && at.getUTCDate() === day && at.getUTCMonth() + 1 === month
}

/** `M4Y1H1` as encoded becomes `M4Y 1H1` as printed. */
const postalCode = (value: string | null): string | null => {
    if (value === null) {
        return null
    }

    // The standard pads to 11 characters with zeroes or spaces.
    const trimmed = value.replace(/[\s0]+$/, '').toUpperCase()

    return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(trimmed)
        ? `${trimmed.slice(0, 3)} ${trimmed.slice(3)}`
        : trimmed || null
}

/** Whether a string looks like the barcode off a licence at all. */
export const looksLikeAamva = (text: string): boolean => text.includes('ANSI ') || /\bDAQ/.test(text)

/**
 * The decoded barcode string, as a `ScannedIdentity`.
 *
 * Returns null when the string is not an AAMVA record — a barcode that decoded
 * cleanly but came off a loyalty card is not an identity document, and saying
 * so is better than returning a shape full of nulls.
 */
export const parseAamva = (
    text: string,
    declaredType: IdentityDocumentType
): ScannedIdentity | null => {
    if (!looksLikeAamva(text)) {
        return null
    }

    const found = new Map<Element, string>()

    /*
     * Elements are `<3-letter id><value>`, one per line. Split on any newline
     * because encoders differ about which they use, and the header before the
     * first subfile contains its own carriage returns.
     */
    for (const line of text.split(/[\r\n]+/)) {
        const id = line.slice(0, 3).toUpperCase()
        const key = ELEMENT[id as keyof typeof ELEMENT]

        if (key !== undefined && !found.has(key)) {
            const value = clean(line.slice(3))

            if (value !== null) {
                found.set(key, value)
            }
        }
    }

    // The licence number is the one element that makes this a licence. Without
    // it, whatever was decoded is not a document we can record.
    if (!found.has('documentNumber')) {
        return null
    }

    const country = found.get('country') ?? null
    const firstName = found.get('firstName') ?? null
    const middleName = found.get('middleName') ?? null
    const lastName = found.get('lastName') ?? null

    const fullName =
        [firstName, middleName, lastName].filter(part => part !== null).join(' ') || null

    return {
        // The barcode is on a driver's licence. A passport has a machine
        // readable zone instead, and nothing here can read one — so a scan
        // declared as a passport that decoded an AAMVA barcode is reported as
        // what it actually is, and the service surfaces the disagreement.
        documentType: 'drivers_licence',

        fullName,
        firstName,
        middleName,
        lastName,

        dateOfBirth: parseDate(found.get('dateOfBirth') ?? null, country),
        expiryDate: parseDate(found.get('expiryDate') ?? null, country),
        dateOfIssue: parseDate(found.get('dateOfIssue') ?? null, country),

        documentNumber: found.get('documentNumber') ?? null,

        address: found.get('address') ?? null,
        city: found.get('city') ?? null,
        province: found.get('province') ?? null,
        postalCode: postalCode(found.get('postalCode') ?? null),

        /*
         * 100, and it means something different from every other provider's
         * confidence. This is not a recognition of printed characters that
         * might be wrong — it is text the issuing authority encoded, read back
         * verbatim. Either the barcode decoded or it did not.
         *
         * `declaredType` is unused for the same reason the type is fixed above:
         * what the barcode is is not a matter of opinion.
         */
        confidence: 100,
        provider: 'barcode',
        modelVersion: `aamva${declaredType === 'passport' ? '-type-mismatch' : ''}`
    }
}
