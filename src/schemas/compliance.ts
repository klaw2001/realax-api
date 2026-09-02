import { registry, z } from '@/openapi/registry'

/**
 * The compliance gate's answer (build plan 2.4).
 *
 * A failure is an object, not a string and not a boolean. The frontend renders
 * these as a checklist an agent works down, so each one has to say three
 * things: which field it is, what an agent calls that field, and where to go to
 * fix it. A list of blank names would be a list nobody outside this repo can
 * read, and a boolean would be a form that will not fill for no stated reason.
 */

/**
 * The page that fixes a failure.
 *
 * Named by what it is rather than by a URL: the API does not know the
 * frontend's routes, and a route table in a response body would be two places
 * to change when a page moves.
 */
export const complianceAreaSchema = registry.register(
    'ComplianceArea',
    z.enum(['profile', 'property', 'parties', 'entries']).openapi({ example: 'entries' })
)

export type ComplianceArea = z.infer<typeof complianceAreaSchema>

/**
 * Why a check failed.
 *
 * `missing` is a blank with nothing for it. `absent` is a party that is not on
 * the transaction at all — a different problem with a different fix, and one
 * that would otherwise be reported as five empty blanks the agent cannot fill
 * individually.
 */
export const complianceReasonSchema = registry.register(
    'ComplianceReason',
    z.enum(['missing', 'absent']).openapi({ example: 'missing' })
)

export type ComplianceReason = z.infer<typeof complianceReasonSchema>

export const complianceFailureSchema = registry.register(
    'ComplianceFailure',
    z.object({
        field: z.string().openapi({
            description:
                'Stable identifier. For a form blank it is the name the curated template gives it; for a rule about the transaction itself it is the rule. Branch on this, not on `label`.',
            example: 'completion.dateDay'
        }),
        label: z.string().openapi({
            description: 'What an agent calls this field. Safe to show as-is.',
            example: 'Completion date'
        }),
        area: complianceAreaSchema,
        areaLabel: z.string().openapi({
            description: 'The name of the page that fixes it, for the link text.',
            example: 'Agreement terms'
        }),
        reason: complianceReasonSchema
    })
)

export type ComplianceFailure = z.infer<typeof complianceFailureSchema>

export const complianceResultSchema = registry.register(
    'ComplianceResult',
    z.object({
        formCode: z.string().openapi({ example: '100' }),
        passed: z.boolean().openapi({ example: false }),
        failures: z.array(complianceFailureSchema).openapi({
            description:
                'Empty when the check passed. Ordered as the form prints, which is the order an agent works down it.'
        }),
        checkedAt: z.iso.datetime().openapi({ example: '2026-09-02T09:00:00.000Z' })
    })
)

export type ComplianceResult = z.infer<typeof complianceResultSchema>

export const complianceResponseSchema = registry.register(
    'ComplianceResponse',
    z.object({
        compliance: complianceResultSchema
    })
)

export type ComplianceResponse = z.infer<typeof complianceResponseSchema>
