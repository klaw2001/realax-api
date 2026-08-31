import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

// Must run before any schema module calls `.openapi()`. Importing this file is
// the only supported way to get the extended `z` — schemas import the registry,
// so the extension is always applied first.
extendZodWithOpenApi(z)

/**
 * The single OpenAPI registry for the API contract.
 *
 * Schema modules under `src/schemas/` register their components and paths
 * against this at import time; `src/openapi/generate.ts` imports them all and
 * emits `openapi.json`. That file is the frontend's only source of API types.
 */
export const registry = new OpenAPIRegistry()

export { z }
