import { cached, invalidate } from '@/lib/redis'

/**
 * Cache policy for Repliers.
 *
 * Repliers bills per request and the same address gets demoed repeatedly, so a
 * miss costs money rather than correctness (rule 7 in `CLAUDE.md`). Everything
 * here is reproducible from upstream — nothing is stored in Redis that is
 * needed to answer a request.
 */

/** 24 hours, per the build plan. Listing facts do not move within a day. */
export const LISTING_TTL_SECONDS = 24 * 60 * 60

/**
 * Searches are cached too, and for the same reason: they are billed the same
 * way, and the demo runs the same query over and over. The build plan only
 * mandates caching by MLS number; this is the same policy applied to the other
 * billed call.
 */
export const SEARCH_TTL_SECONDS = 24 * 60 * 60

/**
 * Key for one listing. Upper-cased so `c5839471` and `C5839471` are one cache
 * entry rather than two billed requests.
 */
export const listingKey = (mlsNumber: string) => `repliers:listing:${mlsNumber.trim().toUpperCase()}`

/**
 * Key for a search.
 *
 * Built from the normalised query rather than the raw string, so trailing
 * whitespace and casing do not each buy their own upstream request.
 */
export const searchKey = (query: string, limit: number) =>
    `repliers:search:${limit}:${query.trim().toLowerCase().replace(/\s+/g, ' ')}`

/**
 * Read-through cache. Thin by design: `cached` already degrades to the origin
 * when Redis is unreachable, so an outage costs money, not correctness.
 */
export const cachedListing = <T>(mlsNumber: string, fn: () => Promise<T>) =>
    cached(listingKey(mlsNumber), LISTING_TTL_SECONDS, fn)

export const cachedSearch = <T>(query: string, limit: number, fn: () => Promise<T>) =>
    cached(searchKey(query, limit), SEARCH_TTL_SECONDS, fn)

/** Drop one listing's entry. For tests and for a forced refresh. */
export const invalidateListing = (mlsNumber: string) => invalidate(listingKey(mlsNumber))

export const invalidateSearch = (query: string, limit: number) => invalidate(searchKey(query, limit))
