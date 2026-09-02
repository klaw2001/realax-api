import fs from 'fs'
import path from 'path'

import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi'

import { registry } from '@/openapi/registry'

// Side-effect imports: every schema module registers itself on import. Add new
// ones here — a schema that is not imported is not in the contract.
import '@/schemas/common'
import '@/schemas/health'
import '@/schemas/brokerage'
import '@/schemas/agent'
import '@/schemas/transaction'
import '@/schemas/property'
import '@/schemas/party'
import '@/schemas/entries'
import '@/schemas/compliance'
import '@/schemas/form'
import '@/schemas/identity'

const OUTPUT = path.resolve(process.cwd(), 'openapi.json')

const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
        title: 'REALAX API',
        version: '0.1.0',
        description:
            'Transaction automation for Ontario realtors. Generated from the Zod schemas in src/schemas — do not hand-edit.'
    },
    servers: [{ url: process.env.API_BASEURL || 'http://localhost:4000' }]
})

fs.writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`)

console.log(`openapi.json written: ${OUTPUT}`)
