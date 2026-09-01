import { env } from '@/config/env'
import logger from '@/lib/logger'
import { cachedListing, cachedSearch } from '@/integrations/repliers/cache'
import {
    repliersListingSchema,
    repliersSearchResponseSchema,
    type RepliersListing,
    type RepliersSearchResponse
} from '@/integrations/repliers/schema'

/**
 * Repliers (MLS) client.
 *
 * The key lives here and only here — the frontend reaches MLS data through our
 * API or not at all (rule 1 in `CLAUDE.md`). Every response is Zod-parsed
 * against schemas built from captured responses; a shape that no longer matches
 * throws rather than returning a listing with blanks in it, because a blank
 * reaches the fill engine and ends up as an empty line on an OREA form.
 */

/** Raised when Repliers answers, but not with something we can use. */
export class RepliersError extends Error {
    constructor(
        readonly kind: 'http' | 'schema' | 'network',
        message: string,
        readonly status?: number
    ) {
        super(message)
        this.name = 'RepliersError'
    }
}

/** How long any one upstream call may take before we give up on it. */
const REQUEST_TIMEOUT_MS = 10_000

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

/**
 * TRREB MLS numbers: one letter then 7–8 digits, e.g. `C5839471`.
 *
 * The sandbox key returns US boards instead, whose numbers are three to five
 * letters then digits (`ACT8714298`, `RECIR2004622`). Both are matched, so
 * switching the key to live TRREB does not require touching this.
 */
const MLS_NUMBER_PATTERN = /^[A-Za-z]{1,5}\d{6,9}$/

/** Whether a search box entry is an MLS number rather than an address. */
export const looksLikeMlsNumber = (query: string) => MLS_NUMBER_PATTERN.test(query.trim())

/**
 * One authenticated GET.
 *
 * Timed out rather than left to hang: this sits behind an agent typing into a
 * search box, and an upstream that never answers must not become a request that
 * never returns.
 */
const get = async (path: string, params: Record<string, string>): Promise<unknown> => {
    const url = new URL(path, env.REPLIERS_BASE_URL)

    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    let response: Response

    try {
        response = await fetch(url, {
            headers: {
                'REPLIERS-API-KEY': env.REPLIERS_API_KEY,
                Accept: 'application/json'
            },
            signal: controller.signal
        })
    } catch (error) {
        // The URL is not in the message: it carries the key's query string in
        // no case today, but the rule is that nothing about this request is
        // reconstructable from a log line.
        throw new RepliersError('network', `Repliers request failed: ${(error as Error).message}`)
    } finally {
        clearTimeout(timer)
    }

    if (!response.ok) {
        throw new RepliersError('http', `Repliers answered ${response.status}`, response.status)
    }

    return response.json()
}

/**
 * Parse a response, or fail loudly.
 *
 * The alternative — returning what parsed and dropping the rest — puts blank
 * fields on a legal document and gives nobody a reason to look. The issue paths
 * are logged because they are the only useful thing about the failure; no
 * values are, because they are a client's property details.
 */
const parse = <T>(schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: { issues: { path: PropertyKey[]; message: string }[] } } }, payload: unknown, what: string): T => {
    const result = schema.safeParse(payload)

    if (!result.success || result.data === undefined) {
        const paths = [...new Set(result.error?.issues.map(issue => issue.path.join('.')) ?? [])]

        logger.error('repliers response did not match the captured schema', { what, paths })

        throw new RepliersError(
            'schema',
            `Repliers ${what} did not match the expected shape (${paths.join(', ') || 'unknown field'})`
        )
    }

    return result.data
}

/**
 * Search listings by address text or MLS number.
 *
 * An MLS number is routed to the detail endpoint and returned as a
 * single-result page, so the caller has one shape to render whichever the agent
 * typed. A number that matches nothing comes back as an empty page rather than
 * an error — "no such listing" is an answer, not a failure.
 */
export const searchListings = async (
    query: string,
    limit = DEFAULT_LIMIT
): Promise<RepliersSearchResponse> => {
    const trimmed = query.trim()
    const size = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT)

    if (trimmed === '') {
        // Not sent upstream: an empty box would return the whole board, one
        // page at a time, and bill for it.
        return { page: 1, numPages: 0, pageSize: size, count: 0, listings: [] }
    }

    if (looksLikeMlsNumber(trimmed)) {
        const listing = await getListing(trimmed)

        return {
            page: 1,
            numPages: listing ? 1 : 0,
            pageSize: size,
            count: listing ? 1 : 0,
            listings: listing ? [listing] : []
        }
    }

    return cachedSearch(trimmed, size, async () => {
        const payload = await get('/listings', {
            search: trimmed,
            searchFields: 'address.streetName,address.streetNumber,address.city',
            pageNum: '1',
            resultsPerPage: String(size)
        })

        const parsed = parse<RepliersSearchResponse>(repliersSearchResponseSchema, payload, 'search')

        if (parsed.unrecognizedParams?.length) {
            // Repliers echoes parameters it did not understand rather than
            // erroring, which means a typo'd filter silently returns unfiltered
            // results.
            logger.warn('repliers ignored query parameters', { params: parsed.unrecognizedParams })
        }

        return parsed
    })
}

/**
 * One listing by MLS number, or `null` when there is no such listing.
 *
 * Cached for 24 hours keyed by the number — the same address is looked up
 * repeatedly through a deal and through a demo, and each miss is billed.
 */
export const getListing = async (mlsNumber: string): Promise<RepliersListing | null> => {
    const trimmed = mlsNumber.trim()

    if (trimmed === '') {
        return null
    }

    return cachedListing(trimmed, async () => {
        try {
            const payload = await get(`/listings/${encodeURIComponent(trimmed)}`, {})

            return parse<RepliersListing>(repliersListingSchema, payload, 'listing')
        } catch (error) {
            if (error instanceof RepliersError && error.status === 404) {
                return null
            }

            throw error
        }
    })
}
