/**
 * Manage the signNow webhook subscriptions this service depends on.
 *
 * Not a capture tool — this one is meant to be re-run. The callback URL is a
 * dev tunnel that changes every time it restarts, and a subscription pointing
 * at a dead URL is deleted by signNow after enough failures, so the five
 * subscriptions have to be recreated regularly. Doing that by hand in the
 * dashboard is how we ended up with 53 subscriptions and no secret on any of
 * them.
 *
 *   npx ts-node -r dotenv/config tools/signnow_subscriptions.ts list
 *   npx ts-node -r dotenv/config tools/signnow_subscriptions.ts sync <callback-url>
 *   npx ts-node -r dotenv/config tools/signnow_subscriptions.ts sync <url> --prune
 *
 * `sync` creates any of the five that are missing, and replaces any whose
 * callback URL or secret is wrong. `--prune` additionally deletes every
 * subscription that is not one of the five.
 *
 * Every subscription is created with `secret_key` set to
 * `SIGNNOW_WEBHOOK_SECRET`. Without it signNow sends no `x-signnow-signature`
 * header, and `/webhooks/signnow` — which sits outside the session guard by
 * necessity, since signNow has no session — has nothing to authenticate with.
 */

const BASE = process.env.SIGNNOW_BASE_URL ?? 'https://api.signnow.com'
const API_KEY = process.env.SIGNNOW_API_KEY ?? ''
const SECRET = process.env.SIGNNOW_WEBHOOK_SECRET ?? ''

/**
 * The only events this service acts on.
 *
 * User-scoped, not document-scoped: a document subscription binds to one
 * `entity_id`, which would mean creating and cleaning up a subscription per
 * envelope. `user.document.*` covers every document the API account sends.
 *
 * Deliberately short. Every extra event is a request our endpoint must answer,
 * and signNow unsubscribes a URL after 30 4xx responses in 60 minutes.
 */
const EVENTS = [
    // The envelope reached the first signer. Moves an envelope to `sent`.
    'user.document.fieldinvite.sent',
    // One signer finished. Sequential signing means the next invite follows.
    'user.document.fieldinvite.signed',
    // Every required field on the document is filled. Terminal.
    'user.document.complete',
    // A signer refused. Terminal, and releases the form for a fresh envelope.
    'user.document.fieldinvite.decline',
    // The invite timed out. Terminal. Cannot be produced on demand, so its
    // payload shape is the one we have never seen.
    'user.invite.expired'
] as const

interface Subscription {
    id: string
    event: string
    active: boolean
    json_attributes?: {
        callback_url?: string
        secret_key?: string
        use_tls_12?: boolean
        include_metadata?: boolean
    }
}

const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
})

/** Every subscription on the account, following pagination to the end. */
const listAll = async (): Promise<Subscription[]> => {
    const found: Subscription[] = []
    let page = 1
    let totalPages = 1

    do {
        const response = await fetch(`${BASE}/v2/event-subscriptions?page=${page}`, {
            headers: headers()
        })

        if (!response.ok) {
            throw new Error(`Could not list subscriptions: ${response.status}`)
        }

        const body = (await response.json()) as {
            data?: Subscription[]
            meta?: { pagination?: { total_pages?: number } }
        }

        found.push(...(body.data ?? []))
        totalPages = body.meta?.pagination?.total_pages ?? 1
        page += 1
    } while (page <= totalPages)

    return found
}

/**
 * The account's own user id, which a user-scoped subscription is bound to.
 *
 * Not optional and not blank: `entity_id: ''` is accepted by neither the API
 * nor common sense, and a subscription without it is silently not created.
 * Read from `GET /user` rather than configured, so it cannot drift from the key.
 */
let cachedUserId: string | null = null

const userId = async (): Promise<string> => {
    if (cachedUserId !== null) {
        return cachedUserId
    }

    const response = await fetch(`${BASE}/user`, { headers: headers() })

    if (!response.ok) {
        throw new Error(`Could not read the account user id: ${response.status}`)
    }

    const body = (await response.json()) as { id?: string }

    if (typeof body.id !== 'string' || body.id === '') {
        throw new Error('GET /user returned no id')
    }

    cachedUserId = body.id

    return cachedUserId
}

const create = async (event: string, callback: string): Promise<void> => {
    const response = await fetch(`${BASE}/v2/event-subscriptions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
            event,
            entity_id: await userId(),
            action: 'callback',
            attributes: {
                callback,
                use_tls_12: true,
                // The whole point of this script.
                secret_key: SECRET,
                // Retries are signNow's, and 5xx never unsubscribes. Left at
                // the maximum: a transient database fault should not cost us
                // the event.
                retry_count: 10,
                delay: 0
            }
        })
    })

    const body = await response.text()

    console.log(`  create ${event} → ${response.status}${response.ok ? '' : ` ${body.slice(0, 200)}`}`)
}

const remove = async (subscription: Subscription): Promise<void> => {
    const response = await fetch(`${BASE}/v2/event-subscriptions/${subscription.id}`, {
        method: 'DELETE',
        headers: headers()
    })

    console.log(`  delete ${subscription.event} → ${response.status}`)
}

/** Whether an existing subscription is already exactly what we want. */
const isCorrect = (subscription: Subscription, callback: string): boolean =>
    subscription.active &&
    subscription.json_attributes?.callback_url === callback &&
    // signNow returns the stored secret, so this compares values rather than
    // merely checking that one is set.
    subscription.json_attributes?.secret_key === SECRET

const main = async (): Promise<void> => {
    if (API_KEY === '') {
        throw new Error('SIGNNOW_API_KEY is not set.')
    }

    const command = process.argv[2]

    if (command === 'list') {
        const all = await listAll()
        const wanted = new Set<string>(EVENTS)

        console.log(`${all.length} subscriptions\n`)

        for (const subscription of all) {
            const attributes = subscription.json_attributes ?? {}
            console.log(
                [
                    wanted.has(subscription.event) ? '*' : ' ',
                    subscription.event.padEnd(46),
                    attributes.secret_key ? 'secret:set' : 'secret:MISSING',
                    subscription.active ? 'active' : 'inactive',
                    attributes.callback_url ?? '(no url)'
                ].join('  ')
            )
        }

        const missingSecret = all.filter(s => !s.json_attributes?.secret_key).length
        console.log(`\n* = one of the ${EVENTS.length} this service uses`)
        console.log(`${missingSecret} of ${all.length} have no secret_key`)

        return
    }

    if (command !== 'sync') {
        console.log('Usage: list | sync <callback-url> [--prune]')
        process.exitCode = 1
        return
    }

    const callback = process.argv[3]

    if (callback === undefined || !callback.startsWith('https://')) {
        throw new Error('sync needs an https callback URL, e.g. https://<tunnel>/webhooks/signnow')
    }

    if (SECRET === '') {
        throw new Error(
            'SIGNNOW_WEBHOOK_SECRET is not set. Without it signNow sends no signature ' +
                'header and the webhook endpoint cannot authenticate anything.'
        )
    }

    const prune = process.argv.includes('--prune')
    const all = await listAll()
    const wanted = new Set<string>(EVENTS)

    console.log(`${all.length} existing subscriptions; syncing ${EVENTS.length} against ${callback}\n`)

    for (const event of EVENTS) {
        const existing = all.filter(subscription => subscription.event === event)
        const good = existing.find(subscription => isCorrect(subscription, callback))

        if (good !== undefined) {
            console.log(`  keep   ${event}`)

            // A duplicate of a correct subscription still delivers, so the
            // handler would see the same event twice. Idempotency covers it,
            // but there is no reason to pay for it.
            for (const duplicate of existing.filter(s => s.id !== good.id)) {
                await remove(duplicate)
            }

            continue
        }

        // No update-in-place: signNow's edit endpoint takes a different auth
        // scheme, and replacing is one code path instead of two.
        for (const stale of existing) {
            await remove(stale)
        }

        await create(event, callback)
    }

    if (prune) {
        const extra = all.filter(subscription => !wanted.has(subscription.event))

        console.log(`\npruning ${extra.length} subscriptions this service does not use`)

        for (const subscription of extra) {
            await remove(subscription)
        }
    }

    const after = await listAll()
    const withSecret = after.filter(s => s.json_attributes?.secret_key === SECRET).length

    console.log(`\nnow ${after.length} subscriptions, ${withSecret} carrying our secret`)
}

main().catch((error: unknown) => {
    console.error(`\n${(error as Error).message}`)
    process.exitCode = 1
})
