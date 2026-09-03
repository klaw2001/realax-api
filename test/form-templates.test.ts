import { readFile } from 'node:fs/promises'
import path from 'node:path'

import prisma from '../src/lib/prisma'
import { getObjectBytes, keys } from '../src/lib/s3'
import {
    SourceHashMismatchError,
    TemplateNotFoundError,
    blanksByName,
    dataBlanks,
    listTemplateCodes,
    loadTemplate,
    paths,
    readSourcePdf,
    reportableBlankNames,
    sha256,
    verifySource
} from '../src/modules/forms/template.service'

// Build plan 2.1. Two halves: the curated template file is what it claims to
// be, and the row plus the S3 object seeded from it agree with it. The second
// half talks to the real bucket and the real database for the same reason the
// storage test does — a mocked S3 would confirm a hash pin that was never
// actually applied to anything.

const FORM = '100'

describe('the curated Form 100 template', () => {
    test('loads, parses and names every blank the extractor found', async () => {
        const template = await loadTemplate(FORM)

        expect(template.form).toEqual(FORM)
        expect(template.revision).toEqual('May 2026')
        expect(template.pageCount).toEqual(6)
        expect(template.blankCount).toEqual(106)
        expect(template.blanks).toHaveLength(106)

        // Zod would have rejected an unnamed blank; this asserts the count, so a
        // re-curation that drops entries fails here rather than at fill time.
        expect(blanksByName(template).size).toEqual(106)
    })

    test('splits agent-filled blanks from the ones a signer supplies', async () => {
        const template = await loadTemplate(FORM)

        const counts = template.blanks.reduce<Record<string, number>>((acc, blank) => {
            acc[blank.kind] = (acc[blank.kind] ?? 0) + 1

            return acc
        }, {})

        expect(counts).toEqual({ data: 76, signature: 17, signingDate: 13 })

        // The compliance gate (2.4) checks these and nothing else. A signature
        // blank counted as missing would block every transaction forever.
        expect(dataBlanks(template)).toHaveLength(76)
        expect(dataBlanks(template).some(blank => blank.name.includes('signature'))).toBe(false)
    })

    test('carries the geometry the fill engine needs on every blank', async () => {
        const template = await loadTemplate(FORM)

        for (const blank of template.blanks) {
            const [x0, y0, x1, y1] = blank.bbox
            expect(x1).toBeGreaterThan(x0)
            expect(y1).toBeGreaterThan(y0)
            expect(blank.page).toBeLessThanOrEqual(template.pageCount)

            const page = template.pages[blank.page - 1]
            expect(x1).toBeLessThanOrEqual(page.width)
            expect(blank.baseline).toBeGreaterThan(0)
            expect(blank.baseline).toBeLessThan(page.height)
        }
    })

    test('names a few blanks the way the mapper will look them up', async () => {
        const byName = blanksByName(await loadTemplate(FORM))

        expect(byName.get('property.address')?.page).toEqual(1)
        expect(byName.get('property.legalDescription')?.page).toEqual(1)
        expect(byName.get('purchasePrice.numeric')?.page).toEqual(1)
        // Page 2 puts the seller's details on the left and the buyer's on the
        // right; getting this pair the wrong way round sends notices to the
        // wrong party, and nothing downstream would notice.
        expect(byName.get('notices.sellerEmail')!.bbox[0]).toBeLessThan(byName.get('notices.buyerEmail')!.bbox[0])
        expect(byName.get('sellerLawyer.name')!.bbox[0]).toBeLessThan(byName.get('buyerLawyer.name')!.bbox[0])
    })

    test('only curated forms are loadable — raw extractor output is not', async () => {
        const codes = await listTemplateCodes()

        expect(codes).toEqual([FORM])

        // 320, 371 and 801 have geometry in forms/templates/*.raw.json and no
        // names. A template row for one of them would be unfillable.
        await expect(loadTemplate('320')).rejects.toThrow(TemplateNotFoundError)
    })

    test('a form code is never treated as a path', async () => {
        await expect(loadTemplate('../../package')).rejects.toThrow(TemplateNotFoundError)
        await expect(loadTemplate('100.raw')).rejects.toThrow(TemplateNotFoundError)
    })
})

describe('the source PDF hash pin', () => {
    test('the blank PDF on disk hashes to what the template pins', async () => {
        const template = await loadTemplate(FORM)
        const pdf = await readSourcePdf(template)

        expect(sha256(pdf)).toEqual(template.sourceSha256)
        expect(pdf.subarray(0, 5).toString()).toEqual('%PDF-')
    })

    test('a tampered source is refused rather than filled', async () => {
        const template = await loadTemplate(FORM)
        const pdf = await readFile(path.join(paths.SOURCES_DIR, template.source))

        // One byte. An OREA revision moves coordinates by a few points and
        // looks entirely plausible on screen — this is the check that stands
        // between that and a signed document with values in the wrong blanks.
        const tampered = Buffer.from(pdf)
        tampered[tampered.length - 1] ^= 0xff

        expect(() => verifySource(template, tampered)).toThrow(SourceHashMismatchError)
        expect(() => verifySource(template, tampered)).toThrow(/does not match the template/)
    })
})

describe('the seeded form library', () => {
    test('Form 100 has a template row pinned to the object in S3', async () => {
        const template = await loadTemplate(FORM)

        const row = await prisma.formTemplate.findUnique({
            where: { formCode_revision: { formCode: FORM, revision: template.revision } }
        })

        expect(row).not.toBeNull()
        expect(row!.sourceSha256).toEqual(template.sourceSha256)
        expect(row!.sourceS3Key).toEqual(keys.formSource(FORM, template.revision))

        const fieldMap = row!.fieldMap as unknown as { blankCount: number; blanks: { name: string }[] }
        expect(fieldMap.blankCount).toEqual(106)
        expect(fieldMap.blanks).toHaveLength(106)

        // The acceptance criterion: the row's hash is the hash of the bytes
        // actually sitting in the bucket, not just of the file in the repo.
        const stored = await getObjectBytes(row!.sourceS3Key)
        expect(sha256(stored)).toEqual(row!.sourceSha256)
    }, 30000)
})

afterAll(async () => {
    await prisma.$disconnect()
})

describe('the names a form is answerable in', () => {
    test('folds a continuation block to one field, and drops nothing else', async () => {
        const template = await loadTemplate('100')
        const blanks = dataBlanks(template)
        const fields = reportableBlankNames(template)

        // Form 100: 76 data blanks, of which 11 are the ruled continuation
        // lines of 3 blocks. So 76 - 11 + 3 = 68 fields.
        expect(blanks).toHaveLength(76)
        expect(fields).toHaveLength(68)

        // A block appears once, under the name its value arrives as — never as
        // its lines.
        expect(fields).toContain('chattelsIncluded')
        expect(fields).not.toContain('chattelsIncluded.line1')

        // Everything else survives unchanged, in the order the form prints.
        expect(fields[0]).toEqual('agreement.dateDay')
        expect(fields).toContain('completion.dateDay')
    })

    test('never names a signature or a signing date', async () => {
        const template = await loadTemplate('100')
        const fields = new Set(reportableBlankNames(template))

        for (const blank of template.blanks) {
            if (blank.kind !== 'data') {
                expect(fields.has(blank.name)).toEqual(false)
            }
        }
    })
})
