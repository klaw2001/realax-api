import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AnalyzeIDResponse } from '@aws-sdk/client-textract'
import request from 'supertest'

import app from '../src/app'
import { OcrError, type OcrProvider, type ScannedIdentity } from '../src/integrations/ocr/provider'
import { __setTextractClient, textractProvider, toScannedIdentity } from '../src/integrations/ocr/textract.client'
import { decryptField, isEncrypted } from '../src/lib/encryption'
import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'
import s3, { keys } from '../src/lib/s3'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { hashPassword } from '../src/modules/auth/auth.service'
import { confirmIdentityScan, scanIdentityDocument } from '../src/modules/identity/identity.service'

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
    await prisma.identityScan.deleteMany({ where: { transaction: { agentId } } })
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
    await prisma.identityScan.deleteMany({ where: { transactionId } })
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

describe('reading a document, which verifies nobody', () => {
    const scanned: ScannedIdentity = {
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

    const scan = (overrides: Partial<ScannedIdentity> = {}) =>
        scanIdentityDocument(
            transactionId,
            agentId,
            transactionPartyId,
            {
                bytes: Buffer.from('a png would be here'),
                mimeType: 'image/png',
                documentType: 'drivers_licence'
            },
            stubProvider({ ...scanned, ...overrides })
        )

    test('an upload creates a reading and no record at all', async () => {
        const result = await scan()

        expect(result.scanId).toEqual(expect.any(String))

        // The point of build plan 2.5's split. Textract's AnalyzeID is trained
        // on US documents and an Ontario licence is not one it was verified
        // against, so a reading nobody has looked at is not a verification —
        // and until an agent says so, there is nothing in the records table to
        // say one happened.
        const records = await prisma.identityRecord.count({ where: { partyId: personId } })

        expect(records).toEqual(0)

        // Nor a Document row: the evidence index describes verifications, and
        // there is not one yet.
        const documents = await prisma.document.count({ where: { transactionId, kind: 'id_scan' } })

        expect(documents).toEqual(0)
    }, 30000)

    test('the document number reaches the pending row encrypted', async () => {
        const result = await scan()

        const row = await prisma.identityScan.findUniqueOrThrow({ where: { id: result.scanId } })

        // The failure this step was about: a column labelled encrypted holding
        // a licence number in plain text. It is true of the waiting row too —
        // waiting is not a reason to hold a number in the clear.
        expect(row.documentNumber).not.toEqual(DOCUMENT_NUMBER)
        expect(row.documentNumber).not.toContain('W1234')
        expect(isEncrypted(row.documentNumber)).toEqual(true)
        expect(decryptField(row.documentNumber)).toEqual(DOCUMENT_NUMBER)
    }, 30000)

    test('the object went to the Canadian bucket under the key convention', async () => {
        const result = await scan()

        const row = await prisma.identityScan.findUniqueOrThrow({ where: { id: result.scanId } })

        expect(row.s3Key).toEqual(
            keys.identityDocument(transactionId, personId, 'drivers_licence', 'png')
        )
        expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
    }, 30000)

    test('the reply says a number was read and never what it is', async () => {
        const result = await scan()

        // A reading that succeeded is not null — the null is reserved for an
        // image the reader found no document in.
        expect(result.scanned).not.toBeNull()
        expect(result.scanned?.documentNumberRead).toEqual(true)
        expect(result.scanned?.lowConfidence).toEqual(false)

        // Not masked, not truncated, not last-four. Absent.
        expect(JSON.stringify(result)).not.toContain(DOCUMENT_NUMBER)
        expect(JSON.stringify(result)).not.toContain('W1234')
    }, 30000)

    test('a scan that read no number says so, and is still a reading', async () => {
        const result = await scan({ documentNumber: null, confidence: 61 })

        expect(result.scanned).not.toBeNull()
        expect(result.scanned?.documentNumberRead).toEqual(false)
        expect(result.scanned?.lowConfidence).toEqual(true)

        const row = await prisma.identityScan.findUniqueOrThrow({ where: { id: result.scanId } })

        expect(row.documentNumber).toEqual('')
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

describe('confirming a reading, which is what verifies somebody', () => {
    const scanned: ScannedIdentity = {
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

    const readOne = async (overrides: Partial<ScannedIdentity> = {}) =>
        (
            await scanIdentityDocument(
                transactionId,
                agentId,
                transactionPartyId,
                {
                    bytes: Buffer.from('a png would be here'),
                    mimeType: 'image/png',
                    documentType: 'drivers_licence'
                },
                stubProvider({ ...scanned, ...overrides })
            )
        ).scanId

    test('the record is written from what the agent confirmed, not what was read', async () => {
        const scanId = await readOne()

        // The agent read the card and the model had the year wrong. Theirs is
        // the value that counts — this is the whole reason a person is asked.
        const record = await confirmIdentityScan(transactionId, agentId, transactionPartyId, scanId, {
            documentType: 'drivers_licence',
            expiryDate: '2031-04-17'
        })

        expect(record.expiryDate).toEqual('2031-04-17')
        expect(record.expired).toEqual(false)

        // A reading assisted this one, however much of it the agent corrected.
        expect(record.verifiedMethod).toEqual('government_photo_id')

        const row = await prisma.identityRecord.findUniqueOrThrow({ where: { id: record.id } })

        expect(row.expiryDate?.toISOString().slice(0, 10)).toEqual('2031-04-17')
    }, 30000)

    test('a document type the agent corrects is the type recorded', async () => {
        const scanId = await readOne()

        const record = await confirmIdentityScan(transactionId, agentId, transactionPartyId, scanId, {
            documentType: 'passport',
            expiryDate: null
        })

        expect(record.documentType).toEqual('passport')
        expect(record.expiryDate).toBeNull()
    }, 30000)

    test('the number moves across as ciphertext and still decrypts to itself', async () => {
        const scanId = await readOne()

        const record = await confirmIdentityScan(transactionId, agentId, transactionPartyId, scanId, {
            documentType: 'drivers_licence',
            expiryDate: '2029-04-17'
        })

        expect(record.documentNumberOnFile).toEqual(true)

        const row = await prisma.identityRecord.findUniqueOrThrow({ where: { id: record.id } })

        expect(isEncrypted(row.documentNumber)).toEqual(true)
        expect(decryptField(row.documentNumber)).toEqual(DOCUMENT_NUMBER)

        // And it is not in what the agent gets back, in any form.
        expect(JSON.stringify(record)).not.toContain(DOCUMENT_NUMBER)
        expect(JSON.stringify(record)).not.toContain('W1234')
    }, 30000)

    test('confirming writes the Document row, and marks the reading spent', async () => {
        const scanId = await readOne()

        const record = await confirmIdentityScan(transactionId, agentId, transactionPartyId, scanId, {
            documentType: 'drivers_licence',
            expiryDate: '2029-04-17'
        })

        const row = await prisma.identityScan.findUniqueOrThrow({ where: { id: scanId } })

        expect(row.confirmedAt).not.toBeNull()
        expect(row.recordId).toEqual(record.id)

        const document = await prisma.document.findFirstOrThrow({
            where: { transactionId, kind: 'id_scan', s3Key: row.s3Key }
        })

        expect(document.sha256).toEqual(row.sha256)
    }, 30000)

    test('confirming the same reading twice is a conflict, not a second record', async () => {
        const scanId = await readOne()

        await confirmIdentityScan(transactionId, agentId, transactionPartyId, scanId, {
            documentType: 'drivers_licence',
            expiryDate: '2029-04-17'
        })

        await expect(
            confirmIdentityScan(transactionId, agentId, transactionPartyId, scanId, {
                documentType: 'drivers_licence',
                expiryDate: '2029-04-17'
            })
        ).rejects.toMatchObject({ name: 'ScanAlreadyConfirmedError' })

        // One photograph, one verification. A retried request does not make two.
        const confirmed = await prisma.identityRecord.count({
            where: { partyId: personId, id: { not: undefined } }
        })

        expect(confirmed).toBeGreaterThan(0)
    }, 30000)

    test('a scan id that is not this party’s is not found', async () => {
        await expect(
            confirmIdentityScan(transactionId, agentId, transactionPartyId, 'not_a_scan', {
                documentType: 'drivers_licence',
                expiryDate: null
            })
        ).rejects.toMatchObject({ name: 'ScanNotFoundError' })
    })

    test('an expired document is recorded as expired rather than as a verification', async () => {
        const scanId = await readOne()

        const record = await confirmIdentityScan(transactionId, agentId, transactionPartyId, scanId, {
            documentType: 'drivers_licence',
            expiryDate: '2019-04-17'
        })

        // A verification on an expired document is not one, and the API says so
        // rather than leaving the screen to work it out from a date.
        expect(record.expired).toEqual(true)
    }, 30000)
})

describe('an image nothing could be read from', () => {
    /** A provider that works, finds no document, and says so. */
    const blindProvider: OcrProvider = {
        name: 'stub',
        scanIdentityDocument: async () => {
            throw new OcrError('unreadable', 'No identity document was found in the image')
        }
    }

    /** A provider that is not reachable at all. A different thing entirely. */
    const downProvider: OcrProvider = {
        name: 'stub',
        scanIdentityDocument: async () => {
            throw new OcrError('unavailable', 'ThrottlingException: rate exceeded')
        }
    }

    const upload = {
        bytes: Buffer.from('a png would be here'),
        mimeType: 'image/png',
        documentType: 'drivers_licence' as const
    }

    test('is still a scan, with no reading on it', async () => {
        const result = await scanIdentityDocument(
            transactionId,
            agentId,
            transactionPartyId,
            upload,
            blindProvider
        )

        // Not an error handed back. The file is stored, the agent has the card,
        // and the only thing missing is the head start on typing.
        expect(result.scanId).toEqual(expect.any(String))

        // Null rather than a shape full of nulls: there was no reading, and
        // "found nothing" and "never ran" are different things to be told.
        expect(result.scanned).toBeNull()

        const row = await prisma.identityScan.findUniqueOrThrow({ where: { id: result.scanId } })

        expect(row.fieldsRead).toEqual(0)
        expect(row.documentNumber).toEqual('')
        expect(row.expiryDate).toBeNull()
        expect(row.confidence).toEqual(0)

        // Stored regardless, so the record that follows is about an object
        // under Object Lock rather than about a photograph nobody kept.
        expect(row.s3Key).toEqual(
            keys.identityDocument(transactionId, personId, 'drivers_licence', 'png')
        )
    }, 30000)

    test('confirms into a record marked as typed by hand', async () => {
        const { scanId } = await scanIdentityDocument(
            transactionId,
            agentId,
            transactionPartyId,
            upload,
            blindProvider
        )

        const record = await confirmIdentityScan(transactionId, agentId, transactionPartyId, scanId, {
            documentType: 'passport',
            expiryDate: '2030-01-31'
        })

        // The same FINTRAC method — the agent looked at a government photo ID
        // either way — but a record whose every value a person typed off the
        // card, which is a thing an examiner can now tell apart.
        expect(record.verifiedMethod).toEqual('government_photo_id_manual')
        expect(record.documentType).toEqual('passport')
        expect(record.expiryDate).toEqual('2030-01-31')
        expect(record.documentNumberOnFile).toEqual(false)
    }, 30000)

    test('a document found but read blank is manual too', async () => {
        const nothingRead: ScannedIdentity = {
            documentType: null,
            fullName: null,
            firstName: null,
            middleName: null,
            lastName: null,
            dateOfBirth: null,
            expiryDate: null,
            dateOfIssue: null,
            documentNumber: null,
            address: null,
            city: null,
            province: null,
            postalCode: null,
            confidence: 0,
            provider: 'stub',
            modelVersion: '1.0'
        }

        const { scanId, scanned } = await scanIdentityDocument(
            transactionId,
            agentId,
            transactionPartyId,
            upload,
            stubProvider(nothingRead)
        )

        // A reading happened and produced nothing, so there is a reading to
        // show — every field of it marked as not read.
        expect(scanned).not.toBeNull()

        const record = await confirmIdentityScan(transactionId, agentId, transactionPartyId, scanId, {
            documentType: 'drivers_licence',
            expiryDate: null
        })

        // Nothing on the record came from the model, so it is manual by the
        // same rule: the count of what was read is what decides, not whether
        // the reader managed to return an envelope.
        expect(record.verifiedMethod).toEqual('government_photo_id_manual')
    }, 30000)

    test('a reader outage is still an error, and is not filed as manual entry', async () => {
        const before = await prisma.identityScan.count({ where: { transactionId, partyId: personId } })

        await expect(
            scanIdentityDocument(transactionId, agentId, transactionPartyId, upload, downProvider)
        ).rejects.toMatchObject({ name: 'OcrError', kind: 'unavailable' })

        // No scan at all, rather than one waiting to be typed into. Silently
        // turning an outage into a typing exercise would stop using a service
        // we pay for without anybody noticing.
        const after = await prisma.identityScan.count({ where: { transactionId, partyId: personId } })

        expect(after).toEqual(before)
    }, 30000)

    test('the contract no longer offers a 422 for it', () => {
        // Asserted against the generated document rather than by posting an
        // image: the POST route uses the real provider, and this suite does not
        // call Textract — an AnalyzeID call is billed, is slow, and needs a
        // real driver's licence to mean anything. The behaviour behind the
        // route is covered by the service tests above; what is left to check is
        // that the contract stopped advertising a failure that no longer
        // happens.
        const spec = JSON.parse(
            readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8')
        ) as { paths: Record<string, { post: { responses: Record<string, unknown> } }> }

        const responses = spec.paths['/api/transactions/{id}/parties/{partyId}/identity'].post.responses

        expect(Object.keys(responses)).toContain('201')
        expect(Object.keys(responses)).not.toContain('422')

        // The outage is still advertised. It is the one OCR failure a caller
        // still has to handle.
        expect(Object.keys(responses)).toContain('502')
    })
})

describe('the confirm endpoint', () => {
    const scanned: ScannedIdentity = {
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

    const readOne = async () =>
        (
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
        ).scanId

    test('confirms over HTTP and answers with the record, number-free', async () => {
        const scanId = await readOne()
        const agent = await signIn()

        const response = await agent
            .post(
                `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity/scans/${scanId}/confirm`
            )
            .send({ documentType: 'drivers_licence', expiryDate: '2029-04-17' })

        expect(response.status).toEqual(201)
        expect(response.body.record.documentNumberOnFile).toEqual(true)
        expect(JSON.stringify(response.body)).not.toContain(DOCUMENT_NUMBER)
        expect(JSON.stringify(response.body)).not.toContain('transactions/')
    }, 30000)

    test('a second confirmation of the same scan is 409', async () => {
        const scanId = await readOne()
        const agent = await signIn()

        const path = `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity/scans/${scanId}/confirm`
        const body = { documentType: 'drivers_licence', expiryDate: '2029-04-17' }

        expect((await agent.post(path).send(body)).status).toEqual(201)

        const again = await agent.post(path).send(body)

        expect(again.status).toEqual(409)
        expect(again.body.error).toEqual('scan_already_confirmed')
    }, 30000)

    test('an unknown scan is 404, and no session is 401', async () => {
        const agent = await signIn()

        const notFound = await agent
            .post(
                `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity/scans/not_a_scan/confirm`
            )
            .send({ documentType: 'drivers_licence', expiryDate: null })

        expect(notFound.status).toEqual(404)
        expect(notFound.body.error).toEqual('scan_not_found')

        const unauthenticated = await request(app)
            .post(
                `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity/scans/whatever/confirm`
            )
            .send({ documentType: 'drivers_licence', expiryDate: null })

        expect(unauthenticated.status).toEqual(401)
    }, 30000)

    test('a body without a confirmed document type is refused', async () => {
        const scanId = await readOne()
        const agent = await signIn()

        const response = await agent
            .post(
                `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity/scans/${scanId}/confirm`
            )
            .send({ expiryDate: '2029-04-17' })

        expect(response.status).toEqual(400)
    }, 30000)
})

describe('reading the records back', () => {
    test('the endpoint lists them without a document number anywhere in the body', async () => {
        const agent = await signIn()

        const response = await agent.get(
            `/api/transactions/${transactionId}/parties/${transactionPartyId}/identity`
        )

        expect(response.status).toEqual(200)
        const records = response.body.records as { documentNumberOnFile: boolean; expired: boolean }[]

        expect(records.length).toBeGreaterThan(0)
        expect(records.some(record => record.documentNumberOnFile)).toEqual(true)

        // Records accumulate rather than replace: each one is evidence that a
        // check happened on a particular day, and the expired one confirmed
        // above is still listed. Hiding it would hide that it was relied on.
        expect(records.some(record => record.expired)).toEqual(true)
        expect(records.some(record => !record.expired)).toEqual(true)

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
