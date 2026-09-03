import { registry, z } from '@/openapi/registry'
import { errorContent } from '@/schemas/common'
import { complianceResultSchema } from '@/schemas/compliance'

/**
 * The curated form template — `forms/templates/<code>.json`.
 *
 * Deliberately **not** registered with the OpenAPI registry — it uses the
 * registry's `z` only for the `.openapi()` extension, and registers nothing.
 * This validates a file on disk, not an HTTP boundary: nothing outside the
 * service ever receives a template, and the endpoints that expose *filled*
 * forms register their own shapes at the foot of this file. Registering it
 * here would put 106 bounding boxes into the frontend's generated types for no
 * consumer.
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

// ---------------------------------------------------------------------------
// The HTTP contract
// ---------------------------------------------------------------------------
//
// Everything above describes the file on disk and is deliberately unregistered
// — 106 bounding boxes are of no use to the frontend. What follows is what the
// endpoints in build plan 2.3 actually publish, which is a great deal less: a
// form's status, and a link to fetch it with.

export const formStatusSchema = registry.register(
    'FormStatus',
    z.enum(['DRAFT', 'FILLED', 'SIGNED']).openapi({ example: 'FILLED' })
)

export type FormStatus = z.infer<typeof formStatusSchema>

/**
 * A form on a transaction, as the frontend sees it.
 *
 * No S3 key. Nothing outside this service reads a bucket path — a filled
 * agreement is fetched through a presigned URL this API issues after its own
 * auth check, and publishing the key would invite a client to build one.
 */
export const transactionFormSchema = registry.register(
    'TransactionForm',
    z.object({
        formCode: z.string().openapi({ example: '100' }),
        revision: z.string().openapi({
            description: 'The OREA revision the template is pinned to.',
            example: 'May 2026'
        }),
        status: formStatusSchema,
        available: z.boolean().openapi({
            description: 'Whether a filled PDF exists to download.',
            example: true
        }),
        filledCount: z.number().int().openapi({
            description:
                'Fields that had a value at the last fill, out of `fieldCount`. Fields, not blanks on the page: the four ruled lines under CHATTELS INCLUDED are one field, and how many of them the text needs is the fill engine\'s business.',
            example: 68
        }),
        fieldCount: z.number().int().openapi({
            description:
                'Fields this form asks the agent for. The same set the compliance gate reports against, so the two agree.',
            example: 68
        })
    })
)

export type TransactionForm = z.infer<typeof transactionFormSchema>

export const transactionFormResponseSchema = registry.register(
    'TransactionFormResponse',
    z.object({ form: transactionFormSchema })
)

export type TransactionFormResponse = z.infer<typeof transactionFormResponseSchema>

/**
 * What a fill answers with.
 *
 * `truncated` sits here rather than on the form itself because it is only
 * knowable at the moment of drawing: whether a value fits is a question about
 * font metrics, and the answer exists in the engine's output and nowhere else.
 * Putting it on the status shape would mean a field that is honest on the reply
 * to a fill and silently always empty everywhere else.
 */
export const fillFormResponseSchema = registry.register(
    'FillFormResponse',
    z.object({
        form: transactionFormSchema,
        truncated: z.array(z.string()).openapi({
            description:
                'Blanks whose value would not fit and was cut down to it, even after shrinking. Empty on a normal fill, and worth showing when it is not: the document says less than the agent typed.',
            example: []
        })
    })
)

export type FillFormResponse = z.infer<typeof fillFormResponseSchema>

/**
 * A link to one filled form.
 *
 * Short-lived and fetched on demand rather than stored anywhere: a URL that
 * grants access to a document is not something to keep in a page's state, a
 * log, or a bookmark.
 */
export const formDownloadResponseSchema = registry.register(
    'FormDownloadResponse',
    z.object({
        url: z.url().openapi({ example: 'https://s3.ca-central-1.amazonaws.com/…' }),
        expiresInSeconds: z.number().int().openapi({ example: 300 }),
        fileName: z.string().openapi({
            description: 'A sensible name to save it as. Carries no client detail.',
            example: 'OREA-100-filled.pdf'
        })
    })
)

export type FormDownloadResponse = z.infer<typeof formDownloadResponseSchema>

const formParams = z.object({
    id: z.string().openapi({ example: 'clx0a1b2c3d4e5f6g7h8i9j0k' }),
    formCode: z.string().openapi({ example: '100' })
})

registry.registerPath({
    method: 'post',
    path: '/api/transactions/{id}/forms/{formCode}/fill',
    summary: 'Fill a form, if the compliance gate passes',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. The compliance gate runs FIRST. If it fails the answer is 422 carrying the failure list and nothing is drawn — no PDF, not even a partial one. There is no override and no force flag. On a pass the form is drawn, stored, and the row moves to FILLED.',
    tags: ['forms'],
    request: { params: formParams },
    responses: {
        200: {
            description: 'The filled form',
            content: { 'application/json': { schema: fillFormResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction, or no curated template for that form'),
        422: {
            description:
                'The compliance gate blocked the fill. `compliance.failures` is the list to show the agent; nothing was written.',
            content: {
                'application/json': {
                    schema: z.object({
                        error: z.string().openapi({ example: 'compliance_failed' }),
                        message: z.string().openapi({
                            example: '7 things need attention before this form can be filled'
                        }),
                        compliance: complianceResultSchema
                    })
                }
            }
        }
    }
})

registry.registerPath({
    method: 'get',
    path: '/api/transactions/{id}/forms/{formCode}',
    summary: "A form's status on a transaction",
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. A form that has never been filled answers 200 with status DRAFT and `available` false rather than 404 — the form exists for the transaction as soon as the template does.',
    tags: ['forms'],
    request: { params: formParams },
    responses: {
        200: {
            description: 'The form',
            content: { 'application/json': { schema: transactionFormResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction, or no curated template for that form')
    }
})

registry.registerPath({
    method: 'get',
    path: '/api/transactions/{id}/forms/{formCode}/download',
    summary: 'A short-lived link to the filled form',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. Issues a presigned URL valid for a few minutes. Nothing in the bucket is public; this is the only way a filled form is read.',
    tags: ['forms'],
    request: { params: formParams },
    responses: {
        200: {
            description: 'The link',
            content: { 'application/json': { schema: formDownloadResponseSchema } }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction, or the form has not been filled')
    }
})

registry.registerPath({
    method: 'get',
    path: '/api/transactions/{id}/forms/{formCode}/compliance',
    summary: 'What is stopping this form from being filled',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session, and the transaction must belong to the caller. The same verdict the fill endpoint gates on, without filling anything and without recording a check — this is what a page reads to show each section as complete or not.',
    tags: ['forms'],
    request: { params: formParams },
    responses: {
        200: {
            description: 'The verdict',
            content: {
                'application/json': {
                    schema: z.object({ compliance: complianceResultSchema })
                }
            }
        },
        401: errorContent('No session'),
        404: errorContent('No such transaction, or no curated template for that form')
    }
})
