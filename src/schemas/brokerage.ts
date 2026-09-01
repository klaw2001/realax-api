import { registry, z } from '@/openapi/registry'
import { errorContent } from '@/schemas/common'

/**
 * A brokerage from the seeded preset table.
 *
 * This is reference data, not something an agent creates. The profile form
 * offers it as a select, and picking one is what fills the address and phone
 * shown alongside it — those belong to the brokerage, not to the agent, so
 * they are never copied onto the agent row.
 *
 * (OCR of the RECO registration certificate is deliberately deferred to a
 * later phase — presets now, OCR later.)
 */
export const brokerageSchema = registry.register(
    'Brokerage',
    z.object({
        id: z.string().openapi({ example: 'seed_brokerage_0001' }),
        name: z.string().openapi({ example: 'Realax Realty Inc., Brokerage' }),
        address: z.string().openapi({ example: '55 Yonge Street, Suite 400, Toronto, ON M5E 1J4' }),
        phone: z.string().nullable().openapi({ example: '416-555-0142' })
    })
)

export type Brokerage = z.infer<typeof brokerageSchema>

export const brokerageListResponseSchema = registry.register(
    'BrokerageListResponse',
    z.object({
        brokerages: z.array(brokerageSchema)
    })
)

export type BrokerageListResponse = z.infer<typeof brokerageListResponseSchema>

registry.registerPath({
    method: 'get',
    path: '/api/agent/brokerages',
    summary: 'The brokerage presets available on the profile form',
    security: [{ sessionCookie: [] }],
    description:
        'Requires a session. Reference data, ordered by name — the profile form renders it as a select, and the selected entry supplies the address and phone displayed next to it.',
    tags: ['agent'],
    responses: {
        200: {
            description: 'Every seeded brokerage',
            content: { 'application/json': { schema: brokerageListResponseSchema } }
        },
        401: errorContent('No session')
    }
})
