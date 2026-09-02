import { Prisma } from '@prisma/client'

import prisma from '@/lib/prisma'
import { getObjectBytes, headObject, keys, putObject } from '@/lib/s3'
import { listTemplateCodes, loadTemplate, readSourcePdf, verifySource } from '@/modules/forms/template.service'

/**
 * Load the form library into S3 and the database (build plan 2.1).
 *
 * Kept apart from `prisma/seed.ts` on purpose. That seed makes up development
 * data and needs nothing but a database; this one publishes real artefacts to a
 * real bucket, so it is not something to run by accident while resetting a
 * local database.
 *
 * Idempotent. Re-running it re-verifies rather than re-uploading: the source
 * PDFs are version-pinned, and a source whose bytes have changed is a new form
 * revision that needs re-extracting, not a silent overwrite.
 *
 *     npm run forms:seed
 *
 * Only curated forms are seeded. A form with `<code>.raw.json` and no
 * `<code>.json` has geometry but no names, and a `FormTemplate` row for it
 * would be a template nothing can fill.
 */

interface SeedResult {
    formCode: string
    revision: string
    sourceS3Key: string
    blankCount: number
    uploaded: boolean
}

async function seedFormTemplate(formCode: string): Promise<SeedResult> {
    const template = await loadTemplate(formCode)

    // Reads from forms/sources/ and throws unless it hashes to the pin. Nothing
    // reaches S3 that the template was not measured against.
    const pdf = await readSourcePdf(template)

    const sourceS3Key = keys.formSource(template.form, template.revision)

    const existing = await headObject(sourceS3Key)
    let uploaded = false

    if (existing) {
        // The object is there. Confirm it is the same PDF rather than assuming
        // it — a bucket shared with an earlier run of a different revision is
        // exactly the case this catches.
        const stored = await getObjectBytes(sourceS3Key)
        verifySource(template, stored)
    } else {
        await putObject({ key: sourceS3Key, body: pdf, contentType: 'application/pdf' })

        // Read back rather than trusting the PUT. This is the object the fill
        // engine will load, and a truncated upload hashes differently.
        const stored = await getObjectBytes(sourceS3Key)
        verifySource(template, stored)
        uploaded = true
    }

    // `fieldMap` is a Prisma Json column. Its `InputJsonValue` type is
    // structural and a Zod-inferred object does not satisfy it — no index
    // signature — even though this value came out of `JSON.parse` and is plain
    // JSON by construction. The cast closes a typing gap, not a real one.
    const fieldMap = template as unknown as Prisma.InputJsonObject

    await prisma.formTemplate.upsert({
        where: { formCode_revision: { formCode: template.form, revision: template.revision } },
        // The curated template is generated output, so an existing row is
        // brought up to date rather than left as whatever an older curation
        // said. The identity of the row is the form and revision; the field map
        // is the thing that gets corrected as blanks are named.
        update: { sourceSha256: template.sourceSha256, sourceS3Key, fieldMap },
        create: {
            formCode: template.form,
            revision: template.revision,
            sourceSha256: template.sourceSha256,
            sourceS3Key,
            fieldMap
        }
    })

    return {
        formCode: template.form,
        revision: template.revision,
        sourceS3Key,
        blankCount: template.blankCount,
        uploaded
    }
}

export async function seedFormTemplates(codes?: string[]): Promise<SeedResult[]> {
    const targets = codes?.length ? codes : await listTemplateCodes()
    const results: SeedResult[] = []

    for (const code of targets) {
        results.push(await seedFormTemplate(code))
    }

    return results
}

async function main() {
    const codes = process.argv.slice(2)
    const results = await seedFormTemplates(codes)

    if (results.length === 0) {
        console.log('no curated templates found in forms/templates/ — nothing to seed')

        return
    }

    for (const result of results) {
        console.log(
            `form ${result.formCode} (${result.revision}): ${result.blankCount} blanks, ` +
                `${result.uploaded ? 'uploaded' : 'already in S3'} → ${result.sourceS3Key}`
        )
    }
}

if (require.main === module) {
    main()
        .catch(error => {
            console.error(error instanceof Error ? error.message : error)
            process.exit(1)
        })
        .finally(async () => {
            await prisma.$disconnect()
        })
}
