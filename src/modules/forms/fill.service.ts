import { Prisma } from '@prisma/client'
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'

import prisma from '@/lib/prisma'
import logger from '@/lib/logger'
import { keys, putObject } from '@/lib/s3'
import {
    buildMergedValues,
    type EntryInput,
    type MergedValues,
    type TransactionSnapshot
} from '@/modules/forms/mapper.service'
import { loadTemplate, readFillSourcePdf, sha256 } from '@/modules/forms/template.service'
import { findProfile } from '@/modules/agent/agent.service'
import { listTransactionParties } from '@/modules/party/party.service'
import { getTransactionProperty } from '@/modules/property/property.service'
import { TransactionNotFoundError } from '@/modules/transaction/transaction.service'
import type { FormTemplate, TemplateBlank } from '@/schemas/form'

/**
 * The fill engine (build plan 2.3).
 *
 * An OREA form has no form fields — it is print output, and every blank is a
 * run of dot leaders in the text layer. So filling one is drawing text at
 * measured coordinates: the curated template says where each blank is, the
 * mapper says what goes in it, and this puts the second onto the first.
 *
 * Three things it refuses to do, each because the failure is a document that
 * looks right:
 *
 * - fill from a PDF that does not hash to the template's pin, since an OREA
 *   revision moves the coordinates and nothing downstream would notice;
 * - draw into a `signature` or `signingDate` blank, since that is a forged
 *   signature rather than a filled form;
 * - report a blank as filled when the value did not fit — it is truncated,
 *   said so, and the caller decides.
 *
 * The `missing` list it returns is the compliance check (2.4). Both come from
 * one pass over one merged object, so the document and the report on it cannot
 * disagree.
 */

/** Helvetica, because that is what the forms are set in. */
const FONT = StandardFonts.Helvetica

/** Ink. Black rather than the blue a wet signature would be — this is typed. */
const INK = rgb(0, 0, 0)

/**
 * Breathing room inside the bounding box, each side. The box is the dot-leader
 * run itself, and text starting exactly on its first pixel reads as touching
 * the printed label before it.
 */
const PAD = 1

/**
 * How small a value may be shrunk before it is truncated instead.
 *
 * Below about 5pt an agreement stops being legible on paper, and a term nobody
 * can read on a signed contract is worse than a visibly cut one.
 */
const MIN_FONT_SIZE = 5

/** What a blank's value became, once measured. */
interface Draw {
    blank: TemplateBlank
    text: string
    fontSize: number
    /** The value did not fit at `MIN_FONT_SIZE` and was cut to fit. */
    truncated: boolean
}

export interface FillOutcome {
    /** Blank names drawn, in template order. */
    filled: string[]

    /**
     * Data blanks with nothing for them. A multi-line block appears here under
     * its base name (`chattelsIncluded`), not once per line — three empty
     * continuation lines are not three missing fields.
     */
    missing: string[]

    /** Names whose value was cut to fit. Empty on a normal fill. */
    truncated: string[]
}

export interface RenderedForm extends FillOutcome {
    bytes: Uint8Array
}

export interface FillResult extends FillOutcome {
    formCode: string
    revision: string
    filledS3Key: string
    /** The bucket is versioned; stored with the row so a fill is reproducible. */
    versionId?: string
    sha256: string
    byteLength: number
}

export class FormTemplateNotSeededError extends Error {
    constructor(formCode: string, revision: string) {
        super(`No FormTemplate row for form ${formCode} (${revision}) — run npm run forms:seed`)
        this.name = 'FormTemplateNotSeededError'
    }
}

// Re-exported, not redeclared — see the note in transaction.service.ts.
export { TransactionNotFoundError }

/**
 * Text as the standard fonts can encode it.
 *
 * `pdf-lib`'s Helvetica is WinAnsi, and it throws on a character outside it
 * rather than dropping one. Everything that reaches here has been through a
 * text input, so the realistic cases are the typographic punctuation a word
 * processor produces on the way through a paste — those are folded to their
 * ASCII equivalents, and anything still unencodable becomes a `?` so that a
 * name with an unexpected glyph in it fills the rest of the form instead of
 * failing it.
 */
const toWinAnsi = (value: string): string =>
    value
        .normalize('NFC')
        .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
        .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/\u2026/g, '...')
        // Every kind of space — including the non-breaking one a paste brings
        // with it — is one ordinary space, so the width measurement below is
        // measuring what a reader will see.
        .replace(/[\s\u00a0\u2007\u202f]+/g, ' ')
        .replace(/[^\u0020-\u007e\u00a1-\u00ff]/g, '?')
        .trim()

/** The drawable width of a blank. */
const usableWidth = (blank: TemplateBlank): number => Math.max(blank.width - PAD * 2, 1)

/**
 * The size a value is drawn at: its blank's size, shrunk to fit, never below
 * `MIN_FONT_SIZE`.
 */
const fitFontSize = (font: PDFFont, text: string, blank: TemplateBlank): number => {
    const available = usableWidth(blank)
    const width = font.widthOfTextAtSize(text, blank.fontSize)

    if (width <= available) {
        return blank.fontSize
    }

    return Math.max(MIN_FONT_SIZE, (blank.fontSize * available) / width)
}

/** Cut to what fits at `size`, with an ellipsis to show that it was cut. */
const truncateToWidth = (font: PDFFont, text: string, size: number, available: number): string => {
    const ellipsis = '...'

    let cut = text
    while (cut.length > 0 && font.widthOfTextAtSize(`${cut}${ellipsis}`, size) > available) {
        cut = cut.slice(0, -1)
    }

    return cut === '' ? '' : `${cut.trimEnd()}${ellipsis}`
}

/** A blank measured: what will be drawn in it, at what size, cut or not. */
const measure = (font: PDFFont, blank: TemplateBlank, value: string): Draw | null => {
    const limited = blank.maxLength === undefined ? value : value.slice(0, blank.maxLength)
    const text = toWinAnsi(limited)

    if (text === '') {
        return null
    }

    const fontSize = fitFontSize(font, text, blank)
    const available = usableWidth(blank)

    if (font.widthOfTextAtSize(text, fontSize) <= available) {
        return { blank, text, fontSize, truncated: false }
    }

    const cut = truncateToWidth(font, text, fontSize, available)

    return cut === '' ? null : { blank, text: cut, fontSize, truncated: true }
}

/**
 * A continuation block: the ruled lines a single value flows across, which the
 * curation marks with a shared `flow`.
 */
interface FlowGroup {
    /** The merged key one value for the whole block arrives under. */
    base: string
    blanks: TemplateBlank[]
}

/**
 * The blocks a template declares, each in template order — which is the order
 * the lines are printed in.
 *
 * These are separate blanks on the form, four ruled lines rather than one box,
 * so the wrapping across them happens here where the font metrics are. The
 * mapper deliberately does not do it: it has no way to know how much fits.
 */
const flowGroups = (template: FormTemplate): FlowGroup[] => {
    const groups = new Map<string, TemplateBlank[]>()

    for (const blank of template.blanks) {
        if (blank.kind !== 'data' || blank.flow === undefined) {
            continue
        }

        groups.set(blank.flow, [...(groups.get(blank.flow) ?? []), blank])
    }

    return [...groups.entries()].map(([base, blanks]) => ({ base, blanks }))
}

/**
 * One long value spread over a group's lines, greedily, at each line's own
 * width.
 *
 * A word longer than a line is placed on its own and left to `measure` to
 * shrink or cut — breaking a word across two ruled lines of a contract reads as
 * two different words.
 */
const wrapAcross = (font: PDFFont, blanks: TemplateBlank[], value: string): string[] => {
    const words = toWinAnsi(value).split(' ').filter(word => word !== '')
    const lines: string[] = []

    let remaining = words

    for (let index = 0; index < blanks.length && remaining.length > 0; index += 1) {
        const blank = blanks[index]
        const available = usableWidth(blank)
        const last = index === blanks.length - 1

        let line = ''

        while (remaining.length > 0) {
            const candidate = line === '' ? remaining[0] : `${line} ${remaining[0]}`

            // The last line takes whatever is left, however long: `measure`
            // shrinks it and cuts it if it still will not fit, and reports the
            // cut, which is more use than dropping the tail silently.
            if (!last && line !== '' && font.widthOfTextAtSize(candidate, blank.fontSize) > available) {
                break
            }

            line = candidate
            remaining = remaining.slice(1)
        }

        lines.push(line)
    }

    return lines
}

/**
 * The merged object resolved against a template: what to draw, what is
 * missing, what had to be cut.
 *
 * Signature and signing-date blanks are skipped whatever the merged object
 * says. The mapper already refuses to emit them; this refuses to draw them.
 * The duplication is deliberate — one of the two is the last thing standing
 * between a bug upstream and a document with a signature nobody wrote.
 */
const resolve = (font: PDFFont, template: FormTemplate, merged: MergedValues) => {
    const groups = flowGroups(template)
    const grouped = new Map<string, string>()
    /** First blank of a block that came out empty → the name it is reported under. */
    const emptyBlocks = new Map<string, string>()
    const draws: Draw[] = []
    const filled: string[] = []
    const missing: string[] = []
    const truncated: string[] = []

    // Wrapping first, so the per-blank pass below finds the line values already
    // decided and treats them like any other.
    for (const group of groups) {
        for (const blank of group.blanks) {
            grouped.set(blank.name, '')
        }

        const explicit = group.blanks.some(blank => merged[blank.name] !== undefined)
        const whole = merged[group.base]

        if (explicit || whole === undefined) {
            for (const blank of group.blanks) {
                grouped.set(blank.name, merged[blank.name] ?? '')
            }
        } else {
            wrapAcross(font, group.blanks, whole).forEach((line, index) => {
                grouped.set(group.blanks[index].name, line)
            })
        }

        // A block with nothing in it is one missing field under its base name.
        // Reporting four would tell an agent to fill in three ruled lines that
        // exist only in case the first one runs out. It is recorded against the
        // block's first blank so the missing list stays in the order the form
        // prints, which is the order an agent works down it.
        if (group.blanks.every(blank => (grouped.get(blank.name) ?? '') === '')) {
            emptyBlocks.set(group.blanks[0].name, group.base)
        }
    }

    const inAGroup = new Set(grouped.keys())

    for (const blank of template.blanks) {
        if (blank.kind !== 'data') {
            continue
        }

        const value = inAGroup.has(blank.name) ? grouped.get(blank.name) : merged[blank.name]
        const draw = value === undefined || value === '' ? null : measure(font, blank, value)

        if (!draw) {
            const block = emptyBlocks.get(blank.name)

            if (block !== undefined) {
                missing.push(block)
            } else if (!inAGroup.has(blank.name)) {
                missing.push(blank.name)
            }

            continue
        }

        draws.push(draw)
        filled.push(blank.name)

        if (draw.truncated) {
            truncated.push(blank.name)
        }
    }

    return { draws, filled, missing, truncated }
}

/** Where the text starts, honouring the blank's alignment hint. */
const startX = (font: PDFFont, draw: Draw): number => {
    const [x0] = draw.blank.bbox
    const width = font.widthOfTextAtSize(draw.text, draw.fontSize)
    const slack = Math.max(usableWidth(draw.blank) - width, 0)

    switch (draw.blank.align) {
        case 'center':
            return x0 + PAD + slack / 2
        case 'right':
            return x0 + PAD + slack
        default:
            return x0 + PAD
    }
}

/**
 * Draw a merged object onto a form.
 *
 * Reads the decrypted source from disk and verifies its pin before opening it,
 * so a fill cannot happen on a PDF the coordinates were not measured on.
 */
export const renderFilledForm = async (
    template: FormTemplate,
    merged: MergedValues
): Promise<RenderedForm> => {
    const source = await readFillSourcePdf(template)

    // `updateMetadata: false` keeps pdf-lib from stamping its own producer and
    // modification date into the document. Without it the same transaction
    // filled twice produces two different SHA-256s, and the hash stored beside
    // the S3 key stops meaning anything.
    const pdf = await PDFDocument.load(source, { updateMetadata: false })
    const font = await pdf.embedFont(FONT)
    const pages = pdf.getPages()

    if (pages.length !== template.pageCount) {
        // The hash pin makes this unreachable; it is here because the next line
        // indexes into `pages` with a number that came out of a JSON file.
        throw new Error(
            `Form ${template.form} source has ${pages.length} pages, template describes ${template.pageCount}`
        )
    }

    const { draws, filled, missing, truncated } = resolve(font, template, merged)

    for (const draw of draws) {
        pages[draw.blank.page - 1].drawText(draw.text, {
            x: startX(font, draw),
            y: draw.blank.baseline,
            size: draw.fontSize,
            font,
            color: INK
        })
    }

    // Flattened output: the values are page content, not annotations, so nothing
    // downstream can edit them back out and no viewer renders them differently.
    const bytes = await pdf.save()

    return { bytes, filled, missing, truncated }
}

/**
 * The snapshot for a transaction the caller owns, assembled from the modules
 * that own each part.
 *
 * `agentId` is passed down rather than checked here, so every read is filtered
 * by ownership in its own query — there is no path that loads another agent's
 * transaction and then decides what to do about it.
 */
export const loadTransactionSnapshot = async (
    transactionId: string,
    agentId: string,
    entries?: EntryInput
): Promise<TransactionSnapshot> => {
    const transaction = await prisma.transaction.findFirst({
        where: { id: transactionId, agentId },
        select: { id: true, type: true }
    })

    if (!transaction) {
        throw new TransactionNotFoundError()
    }

    const [agent, property, parties] = await Promise.all([
        findProfile(agentId),
        getTransactionProperty(transactionId, agentId),
        listTransactionParties(transactionId, agentId)
    ])

    return { transaction: { type: transaction.type }, agent, property, parties: parties ?? [], entries }
}

/**
 * Fill one form for one transaction: render it, store it, record it.
 *
 * The PDF goes to S3 under the transaction's own prefix and the
 * `TransactionForm` row keeps the merged object beside the key it produced, so
 * the compliance gate and the signing flow read what was actually drawn rather
 * than re-deriving it and hoping the inputs have not moved since.
 *
 * The row stays `FILLED` even when fields are missing. Whether a form with gaps
 * may proceed is the gate's decision in 2.4, not the fill engine's — this
 * reports what it drew.
 */
export const fillTransactionForm = async (
    transactionId: string,
    agentId: string,
    formCode: string,
    entries?: EntryInput
): Promise<FillResult> => {
    const template = await loadTemplate(formCode)
    const snapshot = await loadTransactionSnapshot(transactionId, agentId, entries)
    const merged = buildMergedValues(snapshot)

    const rendered = await renderFilledForm(template, merged)
    const body = Buffer.from(rendered.bytes)

    const row = await prisma.formTemplate.findUnique({
        where: { formCode_revision: { formCode: template.form, revision: template.revision } },
        select: { id: true }
    })

    if (!row) {
        throw new FormTemplateNotSeededError(template.form, template.revision)
    }

    const filledS3Key = keys.filledForm(transactionId, template.form)
    const stored = await putObject({ key: filledS3Key, body, contentType: 'application/pdf' })

    // No unique constraint on (transactionId, formTemplateId) to upsert against,
    // and adding one is a migration this task has no other need of — so the row
    // is looked up and updated in place. Re-filling a form replaces its values
    // rather than accumulating a row per attempt.
    const existing = await prisma.transactionForm.findFirst({
        where: { transactionId, formTemplateId: row.id },
        select: { id: true }
    })

    // Keys with nothing behind them are dropped rather than stored as JSON
    // nulls: `values` is the record of what this fill had, and a key present
    // with no value reads as a field that was cleared.
    const values = Object.fromEntries(
        Object.entries(merged).filter(([, value]) => value !== undefined)
    ) as Prisma.InputJsonObject

    if (existing) {
        await prisma.transactionForm.update({
            where: { id: existing.id },
            data: { values, filledS3Key, status: 'FILLED' }
        })
    } else {
        await prisma.transactionForm.create({
            data: { transactionId, formTemplateId: row.id, values, filledS3Key, status: 'FILLED' }
        })
    }

    logger.info('form filled', {
        transactionId,
        formCode: template.form,
        filled: rendered.filled.length,
        missing: rendered.missing.length,
        truncated: rendered.truncated.length
    })

    return {
        formCode: template.form,
        revision: template.revision,
        filledS3Key,
        versionId: stored.versionId,
        sha256: sha256(body),
        byteLength: body.byteLength,
        filled: rendered.filled,
        missing: rendered.missing,
        truncated: rendered.truncated
    }
}
