import type { Request, Response } from 'express'

import { listForms } from '@/modules/forms/catalogue.service'
import type { ErrorResponse } from '@/schemas/common'
import { formCatalogueResponseSchema } from '@/schemas/form'

const unauthorized: ErrorResponse = {
    error: 'unauthorized',
    message: 'Authentication required'
}

/**
 * `GET /api/forms`.
 *
 * The session check is here as well as in `requireAgent` for the same reason
 * every other controller keeps one: the guard is mounted in `app.ts` and a
 * route added below it one day would otherwise answer without a caller.
 */
export const getForms = async (req: Request, res: Response) => {
    if (!req.agent) {
        res.status(401).json(unauthorized)

        return
    }

    res.status(200).json(formCatalogueResponseSchema.parse({ forms: await listForms() }))
}
