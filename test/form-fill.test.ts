import { PDFDocument } from 'pdf-lib'

import prisma from '../src/lib/prisma'
import { getSignedUrl, keys } from '../src/lib/s3'
import s3 from '../src/lib/s3'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { fillTransactionForm, renderFilledForm } from '../src/modules/forms/fill.service'
import { buildMergedValues, type MergedValues, type TransactionSnapshot } from '../src/modules/forms/mapper.service'
import { SourceHashMismatchError, dataBlanks, loadTemplate } from '../src/modules/forms/template.service'

// These tests talk to the real bucket in ca-central-1. Individual cases measure
// 2.5-5s, which sits right on Jest's 5-second default — so the suite passed
// alone and failed under the parallel load of a full run, which is the worst
// kind of failing test: one that is right about the code and wrong about the
// day. The latency is real and worth waiting for; an integration test that
// mocked S3 would confirm a bucket configuration it never checked.
jest.setTimeout(30_000)


// Build plan 2.3. Two halves, the same split the storage and template suites
// use: the drawing itself is a pure function of a template and a merged object
// and is tested as one, and the end of the task — a filled Form 100 an agent can
// download — is checked against the real bucket and the real database, because
// that is the part a mock would confirm without it being true.

const FORM = '100'

const EMAIL = 'form.fill.test.agent@realax.test'

let agentId = ''
let transactionId = ''

const snapshot = (entries?: TransactionSnapshot['entries']): TransactionSnapshot => ({
    transaction: { type: 'PURCHASE' },
    agent: {
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
    },
    property: {
        id: 'property_1',
        mlsNumber: 'C5839471',
        address: '88 Wellesley Street East, Unit 1204',
        city: 'Toronto',
        province: 'ON',
        postalCode: 'M4Y 1H1',
        frontingSide: 'North',
        frontingStreet: 'Wellesley Street East',
        frontage: '49.21 feet',
        depth: '120 feet',
        legalDescription: 'UNIT 4, LEVEL 12, TORONTO STANDARD CONDOMINIUM PLAN NO. 2211',
        listPrice: 1250000,
        taxes: '4,231.00'
    },
    parties: [
        {
            id: 'tp_1',
            personId: 'person_1',
            role: 'BUYER',
            signingOrder: 1,
            fullLegalName: 'Amrita Kaur Sandhu',
            email: 'amrita@example.com',
            phone: '647-555-0111',
            address: '14 Alton Towers Circle',
            city: 'Scarborough',
            province: 'ON',
            postalCode: 'M1V 5N7',
            dateOfBirth: null,
            createdAt: '2026-09-01T09:00:00.000Z',
            updatedAt: '2026-09-01T09:00:00.000Z'
        },
        {
            id: 'tp_2',
            personId: 'person_2',
            role: 'SELLER',
            signingOrder: 1,
            // A curly apostrophe: it is what a name arrives with from a phone
            // keyboard, and Helvetica's WinAnsi encoding does not take one.
            fullLegalName: 'Margaret Eleanor O’Donnell',
            email: 'meo@example.com',
            phone: '416-555-0143',
            address: '88 Wellesley Street East',
            city: 'Toronto',
            province: 'ON',
            postalCode: 'M4Y 1H1',
            dateOfBirth: null,
            createdAt: '2026-09-01T09:00:00.000Z',
            updatedAt: '2026-09-01T09:00:00.000Z'
        }
    ],
    entries
})

const fullEntries = {
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
    irrevocability: { boundParty: 'Buyer', time: '11:59 p.m.', date: '2026-09-04' },
    completion: { date: '2026-11-14' },
    titleSearch: { date: '2026-10-31' },
    hst: { treatment: 'included in' },
    property: { presentUse: 'Residential condominium' },
    chattelsIncluded: 'Refrigerator, stove, built-in dishwasher',
    fixturesExcluded: 'Dining room chandelier',
    rentalItems: ['Hot water tank', 'HVAC equipment'],
    notices: { sellerFax: '416-555-0144', buyerFax: '647-555-0113' },
    sellerLawyer: {
        name: 'Chen & Associates LLP',
        address: '100 King Street West, Suite 3400, Toronto ON M5X 1A9',
        email: 'files@chenlaw.example',
        tel: '416-555-0190',
        fax: '416-555-0191'
    },
    buyerLawyer: {
        name: 'Okonkwo Law Professional Corporation',
        address: '2200 Yonge Street, Suite 900, Toronto ON M4S 2C6',
        email: 'closings@okonkwolaw.example',
        tel: '416-555-0170',
        fax: '416-555-0171'
    }
}

const render = async (merged: MergedValues) => renderFilledForm(await loadTemplate(FORM), merged)

describe('drawing a form', () => {
    test('a populated transaction fills Form 100 and reports what it drew', async () => {
        const result = await render(buildMergedValues(snapshot(fullEntries)))

        expect(result.filled).toContain('buyer.fullLegalNames')
        expect(result.filled).toContain('purchasePrice.numeric')
        expect(result.truncated).toEqual([])

        // On a purchase the agent's own profile fills the co-operating block, so
        // the listing brokerage is the other side's — and this fixture types in
        // no brokerage entries at all. Whether that blocks signing is the
        // compliance gate's question in 2.4, not this one's.
        expect(result.missing).toEqual([
            'listingBrokerage.name',
            'listingBrokerage.tel',
            'listingBrokerage.salesperson'
        ])

        const pdf = await PDFDocument.load(result.bytes)
        expect(pdf.getPageCount()).toEqual(6)
        expect(Buffer.from(result.bytes.subarray(0, 5)).toString()).toEqual('%PDF-')
    })

    test('an empty transaction produces a form and a list, not an error', async () => {
        const template = await loadTemplate(FORM)
        const result = await render({})

        expect(result.filled).toEqual([])

        // Every data blank, with each continuation block counted once under its
        // base name rather than once per ruled line.
        const flowed = dataBlanks(template).filter(blank => blank.flow !== undefined)
        const blocks = new Set(flowed.map(blank => blank.flow))
        expect(result.missing).toHaveLength(dataBlanks(template).length - flowed.length + blocks.size)
        expect(result.missing).toContain('chattelsIncluded')
        expect(result.missing).not.toContain('chattelsIncluded.line1')

        // In the order the form prints, so a compliance report reads down the
        // page rather than in whatever order the blocks were resolved.
        expect(result.missing[0]).toEqual('agreement.dateDay')
        expect(result.missing.indexOf('chattelsIncluded')).toBeGreaterThan(
            result.missing.indexOf('notices.buyerEmail')
        )
        expect(result.missing.indexOf('chattelsIncluded')).toBeLessThan(
            result.missing.indexOf('hst.treatment')
        )
    })

    test('a signature is never drawn, whatever the merged object says', async () => {
        const merged = buildMergedValues(snapshot(fullEntries))

        const forged = await render({
            ...merged,
            'execution.buyer1.signature': 'Amrita Kaur Sandhu',
            'execution.buyer1.date': '2026-09-02',
            'acceptance.signature': 'Margaret Eleanor O’Donnell'
        })
        const clean = await render(merged)

        expect(forged.filled).not.toContain('execution.buyer1.signature')
        expect(forged.missing).not.toContain('execution.buyer1.signature')
        // Byte-identical: the signature values changed nothing about the
        // document, which is the only way to say "not drawn" about a PDF.
        expect(Buffer.from(forged.bytes).equals(Buffer.from(clean.bytes))).toBe(true)
    })

    test('the same inputs produce the same bytes', async () => {
        const merged = buildMergedValues(snapshot(fullEntries))
        const [first, second] = [await render(merged), await render(merged)]

        expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true)
    })

    test('a long block wraps across its ruled lines', async () => {
        const chattels =
            'Refrigerator, stove, built-in dishwasher, over-the-range microwave, stacked washer and dryer, ' +
            'all existing electric light fixtures, all existing window coverings including blinds and drapery ' +
            'tracks, one underground parking space and one storage locker, garage door opener with two remotes'

        const result = await render(buildMergedValues(snapshot({ chattelsIncluded: chattels })))

        expect(result.filled).toContain('chattelsIncluded.line1')
        expect(result.filled).toContain('chattelsIncluded.line2')
        expect(result.filled).toContain('chattelsIncluded.line3')
        expect(result.truncated).toEqual([])
        expect(result.missing).not.toContain('chattelsIncluded')
    })

    test('explicit lines are left where the agent put them', async () => {
        const result = await render(
            buildMergedValues(snapshot({ rentalItems: ['Hot water tank', 'HVAC equipment'] }))
        )

        expect(result.filled).toContain('rentalItems.line1')
        expect(result.filled).toContain('rentalItems.line2')
        expect(result.filled).not.toContain('rentalItems.line3')
    })

    test('an over-long value shrinks to fit, and says so when it cannot', async () => {
        const long =
            'PT LT 24 CON 3 WHITCHURCH AS IN R123456 EXCEPT PT 1 65R-9876 TOGETHER WITH AN EASEMENT OVER PT 2'

        const fits = await render(buildMergedValues(snapshot({ property: { presentUse: long.slice(0, 60) } })))
        expect(fits.filled).toContain('property.presentUse')
        expect(fits.truncated).toEqual([])

        const cut = await render(buildMergedValues(snapshot({ property: { presentUse: long.repeat(4) } })))
        expect(cut.filled).toContain('property.presentUse')
        expect(cut.truncated).toEqual(['property.presentUse'])
    })

    test('a source that is not the pinned one is refused rather than filled', async () => {
        const template = await loadTemplate(FORM)

        // The template is the thing under test here, not the PDF: a revision
        // that moved the coordinates arrives exactly this way — same file name,
        // different bytes, everything still plausible.
        await expect(
            renderFilledForm({ ...template, fillSourceSha256: 'a'.repeat(64) }, {})
        ).rejects.toThrow(SourceHashMismatchError)
    })
})

describe('filling a form for a transaction', () => {
    beforeAll(async () => {
        const agent = await prisma.agent.upsert({
            where: { email: EMAIL },
            update: {},
            create: { email: EMAIL, name: 'Fill Test Agent' }
        })

        agentId = agent.id

        await prisma.transaction.deleteMany({ where: { agentId } })

        const transaction = await prisma.transaction.create({
            data: {
                type: 'PURCHASE',
                agent: { connect: { id: agentId } },
                property: {
                    create: {
                        address: '88 Wellesley Street East, Unit 1204',
                        city: 'Toronto',
                        province: 'ON',
                        postalCode: 'M4Y 1H1',
                        legalDescription: 'UNIT 4, LEVEL 12, TSCP NO. 2211'
                    }
                },
                parties: {
                    create: {
                        role: 'SELLER',
                        signingOrder: 1,
                        party: { create: { fullLegalName: 'Margaret Eleanor O’Donnell' } }
                    }
                }
            }
        })

        transactionId = transaction.id
    })

    afterAll(async () => {
        await s3.send(
            new DeleteObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET,
                Key: keys.filledForm(transactionId, FORM)
            })
        )

        await prisma.transactionForm.deleteMany({ where: { transactionId } })
        await prisma.transactionParty.deleteMany({ where: { transactionId } })
        await prisma.transaction.deleteMany({ where: { agentId } })
        await prisma.party.deleteMany({ where: { fullLegalName: 'Margaret Eleanor O’Donnell' } })
        await prisma.agent.deleteMany({ where: { email: EMAIL } })
        await prisma.$disconnect()
    })

    test('the filled PDF lands in S3 and comes back down a presigned URL', async () => {
        const result = await fillTransactionForm(transactionId, agentId, FORM, {
            agreement: { date: '2026-09-02' },
            purchasePrice: 1250000
        })

        expect(result.filledS3Key).toEqual(keys.filledForm(transactionId, FORM))
        expect(result.versionId).toBeDefined()
        expect(result.filled).toContain('seller.fullLegalNames')
        expect(result.filled).toContain('purchasePrice.numeric')

        const response = await fetch(await getSignedUrl(result.filledS3Key, 60))
        expect(response.status).toEqual(200)

        const downloaded = Buffer.from(await response.arrayBuffer())
        expect(downloaded.byteLength).toEqual(result.byteLength)
        expect((await PDFDocument.load(downloaded)).getPageCount()).toEqual(6)
    }, 30000)

    test('the row records the key and the values that produced it', async () => {
        const row = await prisma.transactionForm.findFirst({ where: { transactionId } })

        expect(row).not.toBeNull()
        expect(row!.status).toEqual('FILLED')
        expect(row!.filledS3Key).toEqual(keys.filledForm(transactionId, FORM))

        const values = row!.values as Record<string, string>
        expect(values['seller.fullLegalNames']).toEqual('Margaret Eleanor O’Donnell')
        // Pruned, not stored as nulls: a key with nothing behind it is a field
        // this fill did not have, and the missing list is where that is said.
        expect(values['listingBrokerage.name']).toBeUndefined()
    }, 30000)

    test('re-filling replaces the row rather than adding one', async () => {
        await fillTransactionForm(transactionId, agentId, FORM)

        expect(await prisma.transactionForm.count({ where: { transactionId } })).toEqual(1)
    }, 30000)

    test("another agent's transaction is not fillable", async () => {
        await expect(fillTransactionForm(transactionId, 'not-this-agent', FORM)).rejects.toThrow(
            'No such transaction'
        )
    })
})
