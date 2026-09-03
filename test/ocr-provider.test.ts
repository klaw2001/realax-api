import { OcrError } from '../src/integrations/ocr/provider'
import { __setMockOutcome, mockProvider } from '../src/integrations/ocr/mock.client'
import { __setTextractClient, textractProvider } from '../src/integrations/ocr/textract.client'

// The reader that needs nothing, and the classification of the failure that
// made it necessary.
//
// Nothing here touches a network, a database, or a bucket — which is the point
// of the mock provider, so its own suite ought to demonstrate it.

describe('the mock reader', () => {
    const KEY = 'transactions/tx_1/ids/p_1/drivers_licence.jpg'

    afterEach(() => {
        __setMockOutcome(null)
    })

    test('fills every field an agent would otherwise type', async () => {
        const scan = await mockProvider.scanIdentityDocument({
            s3Key: KEY,
            declaredType: 'drivers_licence'
        })

        expect(scan.fullName).toBeTruthy()
        expect(scan.firstName).toBeTruthy()
        expect(scan.lastName).toBeTruthy()
        expect(scan.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(scan.documentNumber).toBeTruthy()
        expect(scan.address).toBeTruthy()
        expect(scan.province).toEqual('ON')
        expect(scan.documentType).toEqual('drivers_licence')
    })

    test('the reading says which reader produced it', async () => {
        const scan = await mockProvider.scanIdentityDocument({
            s3Key: KEY,
            declaredType: 'drivers_licence'
        })

        // This is what keeps a fixture-filled record identifiable in the
        // database years later, when nobody remembers which environment
        // variable was set the day it was written.
        expect(scan.provider).toEqual('mock')
        expect(scan.modelVersion).toEqual('fixtures-1')
    })

    test('the same object always reads the same way', async () => {
        const first = await mockProvider.scanIdentityDocument({
            s3Key: KEY,
            declaredType: 'drivers_licence'
        })
        const again = await mockProvider.scanIdentityDocument({
            s3Key: KEY,
            declaredType: 'drivers_licence'
        })

        expect(again.fullName).toEqual(first.fullName)
        expect(again.documentNumber).toEqual(first.documentNumber)
    })

    test('different objects read as different people', async () => {
        // A demo with a seller and a spouse should not show one person twice.
        const names = new Set<string | null>()

        for (const suffix of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
            const scan = await mockProvider.scanIdentityDocument({
                s3Key: `${KEY}.${suffix}`,
                declaredType: 'drivers_licence'
            })

            names.add(scan.fullName)
        }

        expect(names.size).toBeGreaterThan(1)
    })

    test('an expiry that is still in the future, so a demo does not fail a check', async () => {
        const scan = await mockProvider.scanIdentityDocument({
            s3Key: KEY,
            declaredType: 'drivers_licence'
        })

        expect(new Date(`${scan.expiryDate}T00:00:00.000Z`).getTime()).toBeGreaterThan(Date.now())
    })

    test('a passport carries no address, exactly as the real thing does not', async () => {
        const scan = await mockProvider.scanIdentityDocument({
            s3Key: KEY,
            declaredType: 'passport'
        })

        expect(scan.documentType).toEqual('passport')
        expect(scan.address).toBeNull()
        expect(scan.city).toBeNull()
        expect(scan.postalCode).toBeNull()
        expect(scan.documentNumber).toBeTruthy()
    })

    test('the failure paths can be demonstrated too', async () => {
        __setMockOutcome('unreadable')

        await expect(
            mockProvider.scanIdentityDocument({ s3Key: KEY, declaredType: 'drivers_licence' })
        ).rejects.toMatchObject({ name: 'OcrError', kind: 'unreadable' })

        __setMockOutcome('misconfigured')

        await expect(
            mockProvider.scanIdentityDocument({ s3Key: KEY, declaredType: 'drivers_licence' })
        ).rejects.toMatchObject({ name: 'OcrError', kind: 'misconfigured' })
    })
})

describe('a reader refusing us is not a reader being down', () => {
    afterEach(() => {
        __setTextractClient(null)
    })

    test('SubscriptionRequiredException is misconfigured, not unavailable', async () => {
        // The failure this whole item exists because of: a Free-plan AWS
        // account answering every AnalyzeID call the same way, forever. An
        // agent told to try again in a moment would be trying all week.
        const refusal = new Error('The AWS Access Key Id needs a subscription for the service')

        refusal.name = 'SubscriptionRequiredException'

        __setTextractClient({ send: () => Promise.reject(refusal) } as never)

        const error = await textractProvider
            .scanIdentityDocument({
                s3Key: 'transactions/tx_1/ids/p_1/drivers_licence.png',
                declaredType: 'drivers_licence'
            })
            .catch((thrown: unknown) => thrown)

        expect(error).toBeInstanceOf(OcrError)
        expect((error as OcrError).kind).toEqual('misconfigured')

        // Rule 6: the key names an identity scan and never appears in a message.
        expect((error as OcrError).message).not.toContain('transactions/tx_1')
    })

    test('a throttle is still unavailable, because retrying is the right advice', async () => {
        const throttle = new Error('rate exceeded')

        throttle.name = 'ThrottlingException'

        __setTextractClient({ send: () => Promise.reject(throttle) } as never)

        await expect(
            textractProvider.scanIdentityDocument({
                s3Key: 'transactions/tx_1/ids/p_1/drivers_licence.png',
                declaredType: 'drivers_licence'
            })
        ).rejects.toMatchObject({ name: 'OcrError', kind: 'unavailable' })
    })
})
