import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { formTemplateSchema, type FormTemplate, type TemplateBlank } from '@/schemas/form'

/**
 * Loading and verifying the curated OREA form templates.
 *
 * A template is `forms/templates/<code>.json` — the extractor's blank
 * geometry merged with a hand-written curation by `tools/curate_template.py`.
 * It is the only thing that knows where on a page a value goes.
 *
 * The verification here is the point of the module. OREA reissues forms under
 * the same number, and when they do, the dot-leader runs shift by a few points.
 * A template applied to the revision it was not built from produces a document
 * that looks right and puts the completion date in the title search blank —
 * which is worse than an error, because it gets signed. So every load pins the
 * source PDF by SHA-256 and refuses to proceed on a mismatch.
 */

/**
 * `forms/` lives at the repo root, beside `src/`. `rootDir: src` and
 * `outDir: dist` keep this three levels up from `<root>/{src,dist}/modules/forms`
 * either way, so the same path resolves under ts-node and under `npm start`.
 */
const FORMS_DIR = path.resolve(__dirname, '..', '..', '..', 'forms')
const TEMPLATES_DIR = path.join(FORMS_DIR, 'templates')
const SOURCES_DIR = path.join(FORMS_DIR, 'sources')

/** Form codes as OREA prints them: digits, sometimes a trailing letter (`200a`). */
const FORM_CODE = /^[0-9]{1,4}[a-z]?$/

export class TemplateNotFoundError extends Error {
    constructor(public readonly formCode: string) {
        super(`No curated template for form ${formCode}`)
        this.name = 'TemplateNotFoundError'
    }
}

export class TemplateInvalidError extends Error {
    constructor(formCode: string, detail: string) {
        super(`Template for form ${formCode} is not valid: ${detail}`)
        this.name = 'TemplateInvalidError'
    }
}

/**
 * The source PDF does not hash to what the template was built against.
 *
 * Separate from `TemplateInvalidError` because the remedy is different: the
 * template is fine, the PDF underneath it has been replaced, and the fix is to
 * re-extract and re-curate against the new revision.
 */
export class SourceHashMismatchError extends Error {
    constructor(
        public readonly formCode: string,
        public readonly expected: string,
        public readonly actual: string,
        /** Which of the two pinned files disagreed — the OREA original, or the copy filled on. */
        public readonly which: 'source' | 'fillSource' = 'source'
    ) {
        super(
            `${which === 'source' ? 'Source' : 'Decrypted source'} PDF for form ${formCode} ` +
                `does not match the template: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`
        )
        this.name = 'SourceHashMismatchError'
    }
}

export function sha256(bytes: Buffer | Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Templates are committed files that change only on deploy, and one parse is
 * ~106 blanks of Zod. Cached for the process lifetime rather than re-read per
 * fill.
 */
const cache = new Map<string, FormTemplate>()

function templatePath(formCode: string): string {
    if (!FORM_CODE.test(formCode)) {
        // A form code reaches this from a request path. Anything that is not a
        // form code must not become part of a file path.
        throw new TemplateNotFoundError(formCode)
    }

    return path.join(TEMPLATES_DIR, `${formCode}.json`)
}

/**
 * The curated template for a form code.
 *
 * Throws `TemplateNotFoundError` if there is no curated file — an uncurated
 * form has a `<code>.raw.json` and no `<code>.json`, and that is a deliberate
 * distinction: raw geometry with unnamed blanks is not fillable.
 */
export async function loadTemplate(formCode: string): Promise<FormTemplate> {
    const cached = cache.get(formCode)
    if (cached) {
        return cached
    }

    const file = templatePath(formCode)

    let contents: string
    try {
        contents = await readFile(file, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new TemplateNotFoundError(formCode)
        }

        throw error
    }

    let parsedJson: unknown
    try {
        parsedJson = JSON.parse(contents)
    } catch (error) {
        throw new TemplateInvalidError(formCode, (error as Error).message)
    }

    const result = formTemplateSchema.safeParse(parsedJson)
    if (!result.success) {
        const [issue] = result.error.issues
        throw new TemplateInvalidError(formCode, `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    }

    if (result.data.form !== formCode) {
        throw new TemplateInvalidError(formCode, `file declares form '${result.data.form}'`)
    }

    cache.set(formCode, result.data)

    return result.data
}

/** Every form code with a curated template, sorted. */
export async function listTemplateCodes(): Promise<string[]> {
    const entries = await readdir(TEMPLATES_DIR)

    return entries
        .filter(entry => entry.endsWith('.json') && !entry.endsWith('.raw.json') && !entry.endsWith('.names.json'))
        .map(entry => entry.slice(0, -'.json'.length))
        .filter(code => FORM_CODE.test(code))
        .sort()
}

/**
 * Check bytes against the template's pin.
 *
 * Takes the bytes rather than a path so the same check covers the file on disk
 * and the object read back from S3 — the two places a source can drift apart.
 */
export function verifySource(template: FormTemplate, bytes: Buffer | Uint8Array): void {
    const actual = sha256(bytes)

    if (actual !== template.sourceSha256) {
        throw new SourceHashMismatchError(template.form, template.sourceSha256, actual)
    }
}

/**
 * The blank source PDF for a template, verified.
 *
 * Reads from `forms/sources/`. This is the OREA download — the file the blanks
 * were measured on and the one the form library publishes to S3. It is
 * encrypted, so it is not the file the fill engine draws on; see
 * `readFillSourcePdf`.
 */
export async function readSourcePdf(template: FormTemplate): Promise<Buffer> {
    const bytes = await readFile(path.join(SOURCES_DIR, template.source))
    verifySource(template, bytes)

    return bytes
}

/**
 * The decrypted derivative the fill engine draws on, verified against its own
 * pin.
 *
 * Two files exist because `pdf-lib` refuses an encrypted document and
 * `ignoreEncryption` does not help — it skips the permission check and leaves
 * the object streams encrypted. `qpdf --decrypt` produces this copy once per
 * revision and it is committed beside the original, so nothing has to decrypt
 * at runtime.
 *
 * Read from disk rather than S3 on purpose: the form library in the bucket is
 * the published record of what OREA issued, while this is a build artefact of
 * the repo, shipped in the image with the template that pins it. A fill that
 * fetched it over the network could still only accept bytes matching the pin —
 * so the round trip would buy nothing.
 */
export async function readFillSourcePdf(template: FormTemplate): Promise<Buffer> {
    const bytes = await readFile(path.join(SOURCES_DIR, template.fillSource))
    verifyFillSource(template, bytes)

    return bytes
}

/** The same check for the decrypted copy, against its own pin. */
export function verifyFillSource(template: FormTemplate, bytes: Buffer | Uint8Array): void {
    const actual = sha256(bytes)

    if (actual !== template.fillSourceSha256) {
        throw new SourceHashMismatchError(template.form, template.fillSourceSha256, actual, 'fillSource')
    }
}

/**
 * Blanks by name — what the mapper's merged object is keyed against.
 */
export function blanksByName(template: FormTemplate): Map<string, TemplateBlank> {
    return new Map(template.blanks.map(blank => [blank.name, blank]))
}

/**
 * The blanks the agent is responsible for, which is what the compliance gate
 * (build plan 2.4) checks. Signature and signing-date blanks are excluded:
 * they are filled inside the e-sign session and being empty before it is
 * correct, not missing.
 */
export function dataBlanks(template: FormTemplate): TemplateBlank[] {
    return template.blanks.filter(blank => blank.kind === 'data')
}

/** Clears the parse cache. Tests only — templates do not change at runtime. */
export function __clearTemplateCache(): void {
    cache.clear()
}

export const paths = { FORMS_DIR, TEMPLATES_DIR, SOURCES_DIR }
