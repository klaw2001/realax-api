import type { AnalyzeIDResponse } from '@aws-sdk/client-textract'
import request from 'supertest'

import app from '../src/app'
import { OcrError, type OcrProvider } from '../src/integrations/ocr/provider'
import { __setTextractClient, textractProvider, toScannedIdentity } from '../src/integrations/ocr/textract.client'
import { decryptField, isEncrypted } from '../src/lib/encryption'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import s3, { keys } from '../src/lib/s3'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { hashPassword } from '../src/modules/auth/auth.service'
import { scanIdentityDocument } from '../src/modules/identity/identity.service'

// Build plan 2.5. **Textract is never called here.** An AnalyzeID call is
// billed, is slow, and needs a real driver's licence to be worth anything —
// none of which belongs in `npm test`. The client is exercised against captured
// response shapes and a stubbed SDK send(); the service is exercised against a
// stub provider.
//
// The S3 write is real, because it is ours and the storage suite already
// depends on the bucket. The object is deleted afterwards.

const EMAIL = 'identity.test.agent@realax.test'
const PASSWORD = 'a-correct-test-password'

let agentId = ''
let transactionId = ''
let transactionPartyId = ''
let personId = ''

const DOCUMENT_NUMBER = 'W1234-56789-01234'

/**
 * A response in the shape the SDK types describe.
 *
 * Built from `AnalyzeIDResponse`, the vendor's own type, so a change to it is a
 * compile error rather than a test that keeps passing against a shape the API
 * no longer returns.
 */
const analyzeIdResponse = (
    fields: { type: string; value: string; normalized?: string; confidence?: number }[]
): AnalyzeIDResponse => ({
    IdentityDocuments: [
        {
            DocumentIndex: 1,
            IdentityDocumentFields: fields.map(field => ({
                Type: { Text: field.type },
                ValueDetection: {
                    Text: field.value,
                    Confidence: field.confidence ?? 99,
                    ...(field.normalized
                        ? { NormalizedValue: { Value: field.normalized, ValueType: 'DATE' as const } }
                        : {})
                }
            }))
        }
    ],
    AnalyzeIDModelVersion: '1.0'
})

const ontarioLicence = analyzeIdResponse([
    { type: 'FIRST_NAME', value: 'MARGARET' },
    { type: 'MIDDLE_NAME', value: 'ANNE' },
    { type: 'LAST_NAME', value: 'WHITFIELD' },
    { type: 'DOCUMENT_NUMBER', value: DOCUMENT_NUMBER, confidence: 94.2 },
    { type: 'DATE_OF_BIRTH', value: '1979/04/17', normalized: '1979-04-17T00:00:00' },
    { type: 'EXPIRATION_DATE', value: '2029/04/17', normalized: '2029-04-17T00:00:00' },
    { type: 'ADDRESS', value: '18 MAPLE GROVE AVE' },
    { type: 'CITY_IN_ADDRESS', value: 'TORONTO' },
    { type: 'STATE_IN_ADDRESS', value: 'ON' },
    { type: 'ZIP_CODE_IN_ADDRESS', value: 'M4K 2R7' },
    { type: 'ID_TYPE', value: 'DRIVER LICENSE FRONT' },

    // Returned by the model and deliberately not stored: no OREA form and no
    // FINTRAC method asks what class of vehicle somebody may drive.
    { type: 'CLASS', value: 'G' },
    { type: 'RESTRICTIONS', value: 'NONE' }
])

/** A stub provider. The service takes one as a parameter for exactly this. */
const stubProvider = (result: Parameters<typeof Object>[0] | unknown): OcrProvider =>
    ({
        name: 'stub',
        scanIdentityDocument: async () => result
    }) as OcrProvider

const signIn = async () => {
    const agent = request.agent(app)
    const response = await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })

    expect(response.status).toEqual(200)

    return agent
}

beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD)

    const agent = await prisma.agent.upsert({
        where: { email: EMAIL },
        update: { passwordHash },
        create: { email: EMAIL, name: 'Identity Test Agent', passwordHash }
    })

    agentId = agent.id

    const existing = await prisma.transactionParty.findMany({
        where: { transaction: { agentId } },
        select: { partyId: true }
    })

    await prisma.identityRecord.deleteMany({
        where: { partyId: { in: existing.map(p => p.partyId) } }
    })
    await prisma.document.deleteMany({ where: { transaction: { agentId } } })
    await prisma.transactionParty.deleteMany({ where: { transaction: { agentId } } })
    await prisma.transaction.deleteMany({ where: { agentId } })
    await prisma.party.deleteMany({ where: { id: { in: existing.map(p => p.partyId) } } })

    const transaction = await prisma.transaction.create({
        data: {
            type: 'LISTING',
            agentId,
            parties: {
                create: {
                    role: 'SELLER',
                    signingOrder: 1,
                    party: { create: { fullLegalName: 'Margaret Anne Whitfield' } }
                }
            }
        },
        select: { id: true, parties: { select: { id: true, partyId: true } } }
    })

    transactionId = transaction.id
    transactionPartyId = transaction.parties[0].id
    personId = transaction.parties[0].partyId
})

afterAll(async () => {
    await s3
        .send(
            new DeleteObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET,
                Key: keys.identityDocument(transactionId, personId, 'drivers_licence', 'png')
            })
        )
        .catch(() => undefined)

    await prisma.identityRecord.deleteMany({ where: { partyId: personId } })
    await prisma.document.deleteMany({ where: { transactionId } })
    await prisma.transactionParty.deleteMany({ where: { transactionId } })
    await prisma.transaction.deleteMany({ where: { agentId } })
    await prisma.party.deleteMany({ where: { id: personId } })
    await prisma.agent.deleteMany({ where: { email: EMAIL } })

    __setTextractClient(null)

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

describe('a Textract response becomes a scanned identity', () => {
    test('the fields we use are mapped and the ones we do not are dropped', () => {
        const scan = toScannedIdentity(ontarioLicence, 'drivers_licence')

        expect(scan.fullName).toEqual('MARGARET ANNE WHITFIELD')
        expect(scan.documentNumber).toEqual(DOCUMENT_NUMBER)
        expect(scan.dateOfBirth).toEqual('1979-04-17')
        expect(scan.expiryDate).toEqual('2029-04-17')
        expect(scan.city).toEqual('TORONTO')
        expect(scan.province).toEqual('ON')
        expect(scan.postalCode).toEqual('M4K 2R7')
        expect(scan.documentType).toEqual('drivers_licence')
        expect(scan.modelVersion).toEqual('1.0')

        // Licence class and restrictions are returned by the model and stored
        // nowhere. Holding data because a vendor happened to send it is how a
        // system ends up with data it cannot justify.
        expect(Object.keys(scan)).not.toContain('class')
        expect(JSON.stringify(scan)).not.toContain('RESTRICTIONS')
    })

    test('confidence is the lowest field, not the average', () => {
        const scan = toScannedIdentity(ontarioLicence, 'drivers_licence')

        // The document number was the least certain field at 94.2. Averaging
        // would report 98-something and hide the one field that matters most.
        expect(scan.confidence).toBeCloseTo(94.2, 1)
    })

    test('a field name the model returns that we do not know is ignored, not fatal', () => {
        const scan = toScannedIdentity(
            analyzeIdResponse([
                { type: 'FIRST_NAME', value: 'MARGARET' },
                { type: 'SOME_NEW_FIELD_AWS_ADDED', value: 'whatever' }
            ]),
            'drivers_licence'
        )

        // The opposite of how the Repliers client is written, deliberately: an
        // unexpected Repliers shape means our schema is wrong, whereas a new
        // field from an OCR model means the model got better.
        expect(scan.firstName).toEqual('MARGARET')
    })

    test('a field the model named but read nothing for is not a field', () => {
        const scan = toScannedIdentity(
            analyzeIdResponse([
                { type: 'FIRST_NAME', value: 'MARGARET', confidence: 99 },
                { type: 'DOCUMENT_NUMBER', value: '   ', confidence: 3 }
            ]),
            'drivers_licence'
        )

        expect(scan.documentNumber).toBeNull()

        // And its confidence does not drag the result down to the confidence
        // of a blank.
        expect(scan.confidence).toEqual(99)
    })

    test('an ambiguous printed date is left null rather than guessed at', () => {
        const scan = toScannedIdentity(
            analyzeIdResponse([{ type: 'DATE_OF_BIRTH', value: '04/17/1979' }]),
            'drivers_licence'
        )

        // MM/DD and DD/MM are indistinguishable for the first twelve days of a
        // month. A birth date wrong by a month on a FINTRAC record is worse
        // than a blank one the agent fills in.
        expect(scan.dateOfBirth).toBeNull()
    })

    test('a response with no document in it is unreadable, not empty', () => {
        expect(() => toScannedIdentity({ IdentityDocuments: [] }, 'drivers_licence')).toThrow(
            OcrError
        )
    })
})

describe('the Textract client itself', () => {
    test('reads the object out of our own bucket, in our own region', async () => {
        const sent: Record<string, unknown>[] = []

        __setTextractClient({
            send: (command: { input: Record<string, unknown> }) => {
                sent.push(command.input)

                return Promise.resolve(ontarioLicence)
            }
        } as never)

        const scan = await textractProvider.scanIdentityDocument({
            s3Key: 'transactions/tx_1/ids/p_1/drivers_licence.png',
            declaredType: 'drivers_licence'
        })

        expect(scan.documentNumber).toEqual(DOCUMENT_NUMBER)
        expect(sent).toHaveLength(1)
        expect(sent[0]).toEqual({
            DocumentPages: [
                {
                    S3Object: {
                        Bucket: process.env.AWS_S3_BUCKET,
                        Name: 'transactions/tx_1/ids/p_1/drivers_licence.png'
                    }
                }
            ]
        })

        // Bytes are not sent. The document is read from where it is stored, so
        // the record is provably about the object under Object Lock.
        expect(JSON.stringify(sent[0])).not.toContain('Bytes')

        __setTextractClient(null)
    })

    test('an SDK failure becomes an unavailable OcrError, and the key is not in it', async () => {
        __setTextractClient({
            send: () => Promise.reject(new Error('ThrottlingException: rate exceeded'))
        } as never)

        await expect(
            textractProvider.scanIdentityDocument({
                s3Key: 'transactions/tx_1/ids/p_1/drivers_licence.png',
                declaredType: 'drivers_licence'
            })
        ).rejects.toMatchObject({ name: 'OcrError', kind: 'unavailable' })

        __setTextractClient(null)
    })
})

describe('recording a scan', () => {
    const scanned = {
        documentType: 'drivers_licence' as const,
        fullName: 'MARGARET ANNE WHITFIELD',
        firstName: 'MARGARET',
        middleName: 'ANNE',
        lastName: 'WHITFIELD',
        dateOfBirth: '1979-04-17',
        expiryDate: '2029-04-17',
        dateOfIssue: '2024-04-17',
        documentNumber: DOCUMENT_NUMBER,
        address: '18 MAPLE GROVE AVE',
        city: 'TORONTO',
        province: 'ON',
        postalCode: 'M4K 2R7',
        confidence: 94.2,
        provider: 'stub',
        modelVersion: '1.0'
    }

    test('the document number reaches its column encrypted, and decrypts to itself', async () => {
        await scanIdentityDocument(
            transactionId,
            agentId,
            transactionPartyId,
            {
                bytes: Buffer.from('a png would be here'),
                mimeType: 'image/png',
                documentType: 'drivers_licence'
            },
            stubProvider(scanned)
        )

        const row = await prisma.identityRecord.findFirstOrThrow({
            where: { partyId: personId }
        })

        // The failure this whole step was about: a column labelled encrypted
        // holding a licence number in plain text.
        expect(row.documentNumber).not.toEqual(DOCUMENT_NUMBER)
        expect(row.documentNumber).not.toContain('W1234')
        expect(isEncrypted(row.documentNumber)).toEqual(true)
        expect(decryptField(row.documentNumber)).toEqual(DOCUMENT_NUMBER)
    }, 30000)

    test('the object went to the Canadian bucket under the key convention', async () => {
        const document = await prisma.document.findFirstOrThrow({
            where: { transactionId, kind: 'id_scan' }
        })

        expect(document.s3Key).toEqual(
            keys.identityDocument(transactionId, personId, 'drivers_licence', 'png')
        )
        expect(document.sha256).toMatch(/^[0-9a-f]{64}$/)
    })

    test('the reply says a number is held and never what it is', async () => {
        const result = await scanIdentityDocument(
            transactionId,
            agentId,
            transactionPartyId,
            {
                bytes: Buffer.from('a png would be here'),
                mimeType: 'image/png',
                documentType: 'drivers_licence'
            },
            stubProvider(scanned)
        )

        expect(result.record.documentNumberOnFile).toEqual(true)
        expect(result.scanned.documentNumberRead).toEqual(true)
        expect(result.scanned.lowConfidence).toEqual(false)

        // Not masked, not truncated, not last-four. Absent.
        expect(JSON.stringify(result)).not.toContain(DOCUMENT_NUMBER)
        expect(JSON.stringify(result)).not.toContain('W1234')
    }, 30000)

    test('a scan that read no number is recorded as one without', async () => {
        const result = await scanIdentityDocument(
            transactionId,
            agentId,
            transactionPartyId,
            {
                bytes: Buffer.from('a png would be here'),
                mimeType: 'image/png',
                documentType: 'drivers_licence'
            },
            stubProvider({ ...scanned, documentNumber: null, confidence: 61 })
        )

        expect(result.record.documentNumberOnFile).toEqual(false)
        expect(result.scanned.documentNumberRead).toEqual(false)
        expect(result.scanned.lowConfidence).toEqual(true)
    }, 30000)

    test('a file that is not an image is refused before anything is stored', async () => {
        await expect(
            scanIdentityDocument(
                transactionId,
                agentId,
                transactionPartyId,
                {
                    bytes: Buffer.from('%PDF-'),
                    mimeType: 'application/pdf',
                    documentType: 'drivers_licence'
                },
                stubProvider(scanned)
            )
        ).rejects.toMatchObject({ name: 'UnsupportedDocumentError' })
    })

    test('a party on somebody else’s transaction is refused', async () => {
        await expect(
            scanIdentityDocument(
                'not_a_transaction',
                agentId,
                transactionPartyId,
                {
                    bytes: Buffer.from('a png'),
                    mimeType: 'image/png',
                    documentType: 'drivers_licence'
                },
                stubProvider(scanned)
            )
        ).rejects.toMatchObject({ name: 'TransactionNotFoundError' })
    })
})

describe('reading the records back', () => {
    test('the endpoint lists them without a document number anywhere in the body', async () => {
        const agent = await signIn()

        const response = await agent.get(
            `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity`
        )

        expect(response.status).toEqual(200)
        // Three scans were recorded above and all three are held: identity
        // records accumulate rather than replace, because each one is evidence
        // that a check happened on a particular day.
        const records = response.body.records as { documentNumberOnFile: boolean; expired: boolean }[]

        expect(records.length).toBeGreaterThan(0)
        expect(records.some(record => record.documentNumberOnFile)).toEqual(true)
        expect(records.every(record => record.expired === false)).toEqual(true)

        expect(JSON.stringify(response.body)).not.toContain(DOCUMENT_NUMBER)
        expect(JSON.stringify(response.body)).not.toContain('W1234')

        // Nor the bucket path to the scan. Rule 6: an ID scan's key never
        // leaves the service.
        expect(JSON.stringify(response.body)).not.toContain('transactions/')
    })

    test('without a session it is 401', async () => {
        const response = await request(app).get(
            `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity`
        )

        expect(response.status).toEqual(401)
    })

    test('a party that is not on this transaction is 404', async () => {
        const agent = await signIn()

        const response = await agent.get(
            `/api/transactions/${transactionId}/parties/not_a_party/identity`
        )

        expect(response.status).toEqual(404)
        expect(response.body.error).toEqual('party_not_found')
    })
})
