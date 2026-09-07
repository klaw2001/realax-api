import type { FormCatalogueEntry } from '@/schemas/form'
import { listTemplateCodes, loadTemplate, reportableBlankNames } from '@/modules/forms/template.service'

/**
 * The forms this service can fill.
 *
 * Read from `forms/templates/` rather than from the database. The templates
 * directory is what `loadTemplate` will actually open at fill time, so a list
 * built from it cannot offer a form the fill engine would then refuse — which
 * a list built from `FormTemplate` rows could, if the seed had run against a
 * different checkout.
 *
 * Ordered by code, which is the order OREA numbers them and close enough to the
 * order a deal uses them: 100 is the offer, 320 and 801 go with it, 371 comes
 * before all of them. Close enough is deliberate — a genuine workflow order is
 * a product decision, and hard-coding one here would put it in the wrong layer.
 */
export const listForms = async (): Promise<FormCatalogueEntry[]> => {
    const codes = await listTemplateCodes()

    const templates = await Promise.all(codes.map(code => loadTemplate(code)))

    return templates
        .map(template => ({
            code: template.form,
            title: template.title,
            revision: template.revision,
            pageCount: template.pageCount,
            fieldCount: reportableBlankNames(template).length
        }))
        .sort((a, b) => a.code.localeCompare(b.code))
}
