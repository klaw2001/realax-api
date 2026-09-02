import { z } from 'zod'

/**
 * The curated form template — `forms/templates/<code>.json`.
 *
 * Deliberately **not** registered with the OpenAPI registry. This validates a
 * file on disk, not an HTTP boundary: nothing outside the service ever receives
 * a template, and the endpoints that expose *filled* forms (build plan 2.3)
 * will register their own response shapes. Registering it here would put 106
 * bounding boxes into the frontend's generated types for no consumer.
 *
 * The file is produced by `tools/curate_template.py`, which merges the
 * extractor's output with a hand-written curation. It is committed, so this
 * schema exists to catch a bad merge or a hand edit — the same reason every
 * other boundary here is parsed rather than cast.
 */

/**
 * What a blank is for.
 *
 * The split is the one build plan 3.1 needs and 2.4 depends on: a `signature`
 * blank sitting empty before signing is correct, so the compliance gate must
 * not count it as a missing field. Only `data` blanks are the agent's to fill.
 */
export const blankKindSchema = z.enum(['data', 'signature', 'signingDate'])

export type BlankKind = z.infer<typeof blankKindSchema>

/**
 * A bounding box in PDF user space, origin bottom-left: `[x0, y0, x1, y1]`.
 * These are the coordinates the fill engine draws into, so a malformed one is
 * a wrong document rather than an error — hence the length and ordering check.
 */
const bboxSchema = z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .refine(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0, {
        message: 'bbox must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0'
    })

export const templateBlankSchema = z.object({
    /** Stable only within one form revision — `100-p1-b004`. */
    id: z.string().min(1),

    /**
     * The key the field mapper emits and the fill engine looks up. Dot-pathed
     * by domain object (`property.address`, `execution.buyer1.signature`) so
     * the merged object stays readable in a compliance report.
     */
    name: z.string().min(1),

    kind: blankKindSchema,

    page: z.number().int().positive(),
    bbox: bboxSchema,

    /** Text baseline for the run. Drawing from the bbox bottom sits too low. */
    baseline: z.number(),
    width: z.number().positive(),
    fontSize: z.number().positive(),

    /**
     * Printed text either side of the blank on its line. Kept because a
     * compliance message that says "fronting on the ___ side of" is worth more
     * to an agent than one that says `property.frontingSide`.
     */
    label: z.string(),
    labelAfter: z.string(),
    lineText: z.string(),

    // Per-blank fill hints. Absent for nearly every blank — the fill engine
    // derives its defaults from the bounding box.
    align: z.enum(['left', 'center', 'right']).optional(),
    maxLength: z.number().int().positive().optional(),

    /**
     * The continuation block this blank belongs to — `chattelsIncluded` for the
     * four ruled lines under CHATTELS INCLUDED.
     *
     * One value flows across the blanks sharing a `flow`, and the fill engine
     * decides where it breaks because it is the only part of this that has the
     * font metrics. Curated rather than inferred from the `.lineN` names: an
     * address block is also printed on two lines, and its second line is the
     * city and postal code rather than the overflow of the first, so a form
     * that guessed would put a street address across both and report nothing
     * missing.
     */
    flow: z.string().min(1).optional(),

    note: z.string().optional()
})

export type TemplateBlank = z.infer<typeof templateBlankSchema>

export const templatePageSchema = z.object({
    page: z.number().int().positive(),
    width: z.number().positive(),
    height: z.number().positive(),
    rotate: z.number().int(),
    mediaBox: z.tuple([z.number(), z.number(), z.number(), z.number()])
})

export const formTemplateSchema = z
    .object({
        /** OREA form number as printed — `100`, `320`, `801`. */
        form: z.string().min(1),

        /** The revision line at the foot of the form — "May 2026". */
        revision: z.string().min(1),

        /** File name under `forms/sources/`. */
        source: z.string().min(1),

        /**
         * SHA-256 of that PDF. OREA reissues forms without renaming them and
         * the coordinates move, so this is the pin: the fill engine refuses a
         * source that does not hash to this.
         */
        sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),

        /**
         * The decrypted derivative the fill engine actually draws on, relative
         * to `forms/sources/` — `decrypted/100.pdf`.
         *
         * OREA publishes these encrypted and `pdf-lib` refuses an encrypted
         * document outright, so one `qpdf --decrypt` per revision produces a
         * copy it can open. The blanks are measured on the original above; this
         * is the same page content with the security handler removed.
         */
        fillSource: z.string().min(1),

        /**
         * SHA-256 of that derivative. A second pin rather than a reuse of the
         * first: the two files have different bytes by construction, and the
         * one that has to be right at fill time is this one.
         */
        fillSourceSha256: z.string().regex(/^[0-9a-f]{64}$/),

        generator: z.string().min(1),
        coordinateSpace: z.literal('pdf-user-space-origin-bottom-left'),
        units: z.literal('pt'),
        extraction: z.record(z.string(), z.unknown()),

        pageCount: z.number().int().positive(),
        pages: z.array(templatePageSchema).min(1),

        blankCount: z.number().int().nonnegative(),
        blanks: z.array(templateBlankSchema)
    })
    .superRefine((template, ctx) => {
        if (template.blanks.length !== template.blankCount) {
            ctx.addIssue({
                code: 'custom',
                path: ['blankCount'],
                message: `blankCount is ${template.blankCount} but the file carries ${template.blanks.length} blanks`
            })
        }

        if (template.pages.length !== template.pageCount) {
            ctx.addIssue({
                code: 'custom',
                path: ['pageCount'],
                message: `pageCount is ${template.pageCount} but the file describes ${template.pages.length} pages`
            })
        }

        // Two blanks under one name would have the fill engine write a value
        // into two places. That is occasionally intended and never accidental,
        // so it has to be spelled some other way than a duplicate.
        const seen = new Map<string, string>()
        template.blanks.forEach((blank, index) => {
            const previous = seen.get(blank.name)
            if (previous) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['blanks', index, 'name'],
                    message: `name '${blank.name}' is already used by blank ${previous}`
                })
            } else {
                seen.set(blank.name, blank.id)
            }

            if (blank.page > template.pageCount) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['blanks', index, 'page'],
                    message: `blank ${blank.id} is on page ${blank.page}, but the form has ${template.pageCount}`
                })
            }
        })
    })

export type FormTemplate = z.infer<typeof formTemplateSchema>
