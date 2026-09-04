import { createHash } from 'crypto'

import type { Request, Response } from 'express'

import logger from '@/lib/logger'
import { signNowProvider } from '@/integrations/signnow'
import { webhookEventSchema } from '@/integrations/signnow/schema'
import { recordSignerEvent } from '@/modules/signing/signing.service'

/**
 * signNow callbacks (build plan 3.3).
 *
 * **This handler deliberately has no `req.agent` check**, unlike every other
 * controller in this codebase. signNow has no session and never will; the
 * route is mounted above the session guard in `app.ts` on purpose, and it
 * authenticates each request itself by HMAC over the raw body. Adding the
 * usual guard here would 401 every callback and, within an hour, cost us the
 * subscription — see below.
 *
 * **It also answers 200 to things it refuses.** signNow gives 4xx responses no
 * retries and unsubscribes a callback URL after 30 of them in 60 minutes,
 * emailing a cancellation. So "reject" here means *persist nothing and return
 * 200*, and only a genuine internal fault — the database being unreachable —
 * is allowed to surface as a 5xx, which signNow retries and which never
 * unsubscribes. `REALAX_BUILD_PLAN.md` 3.3 says "an unsigned payload is
 * rejected"; rejected in the sense of not recorded, not in the sense of a
 * status code.
 *
 * The `.catch(next)` on the route is therefore correct rather than an
 * oversight: an unexpected throw becomes a 500 and signNow tries again. Every
 * *expected* failure is caught here and answered 200.
 */

const acknowledge = (res: Response): void => {
    res.status(200).json({ received: true })
}

/** `POST /webhooks/signnow`. */
export const postWebhook = async (req: Request, res: Response) => {
    // `express.raw` is mounted for this path only, above the global JSON
    // parser. If that ever stops being true this is an empty buffer, every
    // signature fails, and the log below says so rather than the endpoint
    // silently accepting anything.
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const header = req.header('x-signnow-signature')

    if (!signNowProvider().verifyWebhookSignature(raw, header)) {
        // Never the body and never the header value: an unverified payload is
        // by definition from an unknown source, and copying it into our logs
        // is how somebody else's data becomes our problem.
        logger.warn('signnow webhook signature rejected', {
            hasHeader: header !== undefined,
            bytes: raw.length
        })

        acknowledge(res)
        return
    }

    let parsed: unknown

    try {
        parsed = JSON.parse(raw.toString('utf8'))
    } catch {
        logger.warn('signnow webhook body was not json', { bytes: raw.length })
        acknowledge(res)
        return
    }

    const event = webhookEventSchema.safeParse(parsed)

    if (!event.success) {
        // Paths only. The schema is deliberately narrow — `meta.event` and
        // `content.document_id` — so this fires for a genuinely unfamiliar
        // shape rather than for an event type we have not captured.
        const paths = [...new Set(event.error.issues.map(issue => issue.path.join('.')))]

        logger.error('signnow webhook did not match the captured schema', { paths })

        acknowledge(res)
        return
    }

    const { event: eventType } = event.data.meta
    const { document_id: externalId } = event.data.content

    // The vendor's own event id would be the natural key. The captured payloads
    // carry none, so the body hash is used instead — which is correct anyway,
    // because a retry redelivers the identical bytes.
    const dedupeKey = createHash('sha256').update(raw).digest('hex')

    const outcome = await recordSignerEvent(externalId, eventType, event.data, dedupeKey)

    if (outcome === 'unknown_document') {
        // `info`, not `warn`: the API account is shared with the capture
        // tooling and with anything tried by hand in the dashboard, and those
        // documents legitimately have no envelope row. A signNow document id is
        // a vendor identifier rather than client data, so logging it is fine
        // under rule 6 and it is the only useful thing here.
        logger.info('signnow webhook for a document we did not send', { eventType, externalId })
    }

    acknowledge(res)
}
