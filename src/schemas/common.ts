import { registry, z } from '@/openapi/registry'

/**
 * The shape every non-2xx response takes. Registered once so the frontend gets
 * a single generated type for errors instead of one per endpoint.
 *
 * `message` is safe to show a user. It never carries a client name, an identity
 * document number, or an S3 key.
 */
export const errorResponseSchema = registry.register(
    'ErrorResponse',
    z.object({
        error: z.string().openapi({
            description: 'Stable machine-readable code. Branch on this, not on `message`.',
            example: 'unauthorized'
        }),
        message: z.string().openapi({ example: 'Authentication required' })
    })
)

export type ErrorResponse = z.infer<typeof errorResponseSchema>

/**
 * Reusable `content` block for an error status code.
 */
export const errorContent = (description: string) => ({
    description,
    content: { 'application/json': { schema: errorResponseSchema } }
})
