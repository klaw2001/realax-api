import { createHash } from 'node:crypto'

import {
    OcrError,
    type IdentityDocumentType,
    type OcrProvider,
    type ScanRequest,
    type ScannedIdentity
} from '@/integrations/ocr/provider'
import logger from '@/lib/logger'

/**
 * A reader that reads nothing — fixtures, for development and demos.
 *
 * **It never touches the network and needs no key.** That is the whole point:
 * Textract is a Paid-plan AWS service and this project's account is on the Free
 * plan, so every `AnalyzeID` call is refused and nothing downstream of Read ID
 * could be demonstrated or tested. With `OCR_PROVIDER=mock` the identity flow —
 * upload, read, confirm, record — runs end to end offline, and the test suite
 * gets a provider that cannot fail for billing reasons.
 *
 * ## What it returns, and why it is deterministic
 *
 * The fixture is chosen by hashing the S3 key. So the same object always reads
 * the same way — a demo that is re-run does not change the person's name
 * halfway through — while two different uploads give two different people,
 * which is what makes a transaction with a seller and a spouse look like one.
 *
 * ## The data is conspicuously fake, on purpose
 *
 * Every name, address and document number below is invented and reads as
 * invented. A fixture that looked like a real Ontario licence would eventually
 * be mistaken for one in a screenshot or a support ticket. The reading also
 * carries `provider: 'mock'`, which the service writes onto the scan row, so a
 * record produced this way stays identifiable in the database forever — not
 * just for as long as somebody remembers which environment it came from.
 *
 * ## It cannot serve production
 *
 * `env.ts` refuses to boot with any provider but Textract when `NODE_ENV` is
 * production, and the boot log names the active reader. A demo reader quietly
 * verifying real clients is the failure mode worth designing out, not the one
 * worth remembering to avoid.
 */

/** Deterministic, and far enough out that a demo does not expire mid-year. */
const yearsFromToday = (years: number): string => {
    const date = new Date()

    date.setUTCFullYear(date.getUTCFullYear() + years)

    return date.toISOString().slice(0, 10)
}

interface Fixture {
    firstName: string
    middleName: string | null
    lastName: string
    dateOfBirth: string
    documentNumber: string
    address: string
    city: string
    postalCode: string
}

/**
 * The cast. Ontario addresses and an Ontario-shaped licence number (one letter,
 * fourteen digits) so the fields exercise the same formatting the real thing
 * will, without any of them belonging to anybody.
 */
const FIXTURES: readonly Fixture[] = [
    {
        firstName: 'JORDAN',
        middleName: 'AVERY',
        lastName: 'SAMPLE',
        dateOfBirth: '1984-03-17',
        documentNumber: 'S1111-22222-33333',
        address: '120 EXAMPLE STREET',
        city: 'TORONTO',
        postalCode: 'M5V 2T6'
    },
    {
        firstName: 'MORGAN',
        middleName: null,
        lastName: 'TESTERLY',
        dateOfBirth: '1979-11-02',
        documentNumber: 'T4444-55555-66666',
        address: '87 SPECIMEN AVENUE',
        city: 'MISSISSAUGA',
        postalCode: 'L5B 1M2'
    },
    {
        firstName: 'CASEY',
        middleName: 'LEE',
        lastName: 'PLACEHOLDER',
        dateOfBirth: '1991-06-25',
        documentNumber: 'P7777-88888-99999',
        address: '15 FIXTURE CRESCENT',
        city: 'OTTAWA',
        postalCode: 'K1P 5G4'
    },
    {
        firstName: 'RILEY',
        middleName: 'QUINN',
        lastName: 'MOCKTON',
        dateOfBirth: '1968-01-09',
        documentNumber: 'M2222-33333-44444',
        address: '402 DEMO ROAD',
        city: 'HAMILTON',
        postalCode: 'L8P 1A1'
    }
]

/** Same key, same person. Different keys, different people. */
const fixtureFor = (s3Key: string): Fixture => {
    const digest = createHash('sha256').update(s3Key).digest()

    return FIXTURES[digest[0] % FIXTURES.length]
}

/**
 * Forces the next read to fail, for exercising the paths a fixture never takes.
 *
 * Tests and manual demos only — nothing in the application sets it. `null`
 * restores the normal behaviour.
 */
let forcedOutcome: 'unreadable' | 'unavailable' | 'misconfigured' | null = null

export const __setMockOutcome = (
    outcome: 'unreadable' | 'unavailable' | 'misconfigured' | null
): void => {
    forcedOutcome = outcome
}

const toScannedIdentity = (
    fixture: Fixture,
    declaredType: IdentityDocumentType
): ScannedIdentity => {
    const fullName = [fixture.firstName, fixture.middleName, fixture.lastName]
        .filter(part => part !== null)
        .join(' ')

    // A passport carries no address, so the passport fixture does not either.
    // The shapes the agent has to correct should differ the way the real ones
    // do, or the form is only ever tested against its easiest case.
    const isPassport = declaredType === 'passport'

    return {
        documentType: declaredType,

        fullName,
        firstName: fixture.firstName,
        middleName: fixture.middleName,
        lastName: fixture.lastName,

        dateOfBirth: fixture.dateOfBirth,
        expiryDate: yearsFromToday(3),
        dateOfIssue: yearsFromToday(-2),

        documentNumber: isPassport
            ? fixture.documentNumber.replace(/-/g, '').slice(0, 8)
            : fixture.documentNumber,

        address: isPassport ? null : fixture.address,
        city: isPassport ? null : fixture.city,
        province: isPassport ? null : 'ON',
        postalCode: isPassport ? null : fixture.postalCode,

        // High, but not 100: the agent should still see the ordinary
        // "check this against the card" presentation rather than a
        // confidence value no real reader ever returns.
        confidence: 98,
        provider: 'mock',
        modelVersion: 'fixtures-1'
    }
}

/** The fixture implementation of the OCR boundary. */
export const mockProvider: OcrProvider = {
    name: 'mock',

    async scanIdentityDocument({ s3Key, declaredType }: ScanRequest): Promise<ScannedIdentity> {
        if (forcedOutcome !== null) {
            const outcome = forcedOutcome

            throw new OcrError(outcome, `mock reader forced outcome: ${outcome}`)
        }

        const scanned = toScannedIdentity(fixtureFor(s3Key), declaredType)

        // Same line the real providers log, minus anything read off the card.
        // The provider name is the point of it: a reading in the logs should
        // say which reader produced it without cross-referencing a deploy.
        logger.info('identity document read', {
            provider: scanned.provider,
            modelVersion: scanned.modelVersion,
            confidence: scanned.confidence
        })

        return scanned
    }
}
