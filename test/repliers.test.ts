import { getListing, looksLikeMlsNumber, searchListings, RepliersError } from '../src/integrations/repliers/client'
import { invalidateListing, invalidateSearch, listingKey, searchKey } from '../src/integrations/repliers/cache'
import {
    repliersListingSchema,
    repliersSearchResponseSchema
} from '../src/integrations/repliers/schema'
import { disconnect as disconnectRedis } from '../src/lib/redis'

import searchFixture from './fixtures/repliers/search-listings.json'
import emptySearchFixture from './fixtures/repliers/search-listings-empty.json'
import listingFixture from './fixtures/repliers/get-listing.json'

// The MLS number in the captured fixture. Live calls in this suite use it, so
// the two halves exercise the same listing.
const CAPTURED_MLS = listingFixture.mlsNumber

// An address that exists in the sandbox dataset, from the same capture.
const CAPTURED_STREET = listingFixture.address.streetName

afterAll(async () => {
    await disconnectRedis()
})

/*
 * These parse the responses that are actually in the repo. They are the tests
 * that would catch a schema edit made without a new capture behind it — no
 * network, so they run everywhere and cost nothing.
 */
describe('the captured responses parse', () => {
    test('a search response parses clean', () => {
        const result = repliersSearchResponseSchema.safeParse(searchFixture)

        expect(result.success).toBe(true)
    })

    test('an empty search response parses clean', () => {
        const result = repliersSearchResponseSchema.safeParse(emptySearchFixture)

        expect(result.success).toBe(true)
        expect(result.data?.listings).toEqual([])
        expect(result.data?.count).toEqual(0)
    })

    test('a listing detail response parses clean', () => {
        const result = repliersListingSchema.safeParse(listingFixture)

        expect(result.success).toBe(true)
        expect(result.data?.mlsNumber).toEqual(CAPTURED_MLS)
        expect(result.data?.address.city).toEqual(listingFixture.address.city)
    })

    test('`count` is the total across pages, not the page length', () => {
        const parsed = repliersSearchResponseSchema.parse(searchFixture)

        expect(parsed.count).toBeGreaterThan(parsed.listings.length)
    })

    test('lot.size parses whether it arrives as a string or a number', () => {
        const asString = repliersListingSchema.parse({ ...listingFixture, lot: { size: '8058.6' } })
        const asNumber = repliersListingSchema.parse({ ...listingFixture, lot: { size: 8058.6 } })

        expect(asString.lot?.size).toEqual('8058.6')
        expect(asNumber.lot?.size).toEqual(8058.6)
    })

    test('an unknown field upstream is ignored, not rejected', () => {
        const result = repliersListingSchema.safeParse({
            ...listingFixture,
            somethingRepliersAddedLater: { nested: true }
        })

        expect(result.success).toBe(true)
    })

    test('a field we read going missing is rejected, not defaulted', () => {
        const { mlsNumber: _dropped, ...withoutMls } = listingFixture

        expect(repliersListingSchema.safeParse(withoutMls).success).toBe(false)

        const renamed = { ...listingFixture, listPrice: '369000' }

        expect(repliersListingSchema.safeParse(renamed).success).toBe(false)
    })
})

describe('telling an MLS number from an address', () => {
    test('matches the TRREB pattern from the build plan', () => {
        expect(looksLikeMlsNumber('C5839471')).toBe(true)
        expect(looksLikeMlsNumber('W12345678')).toBe(true)
    })

    test('matches the US board numbers the sandbox key actually returns', () => {
        expect(looksLikeMlsNumber(CAPTURED_MLS)).toBe(true)
        expect(looksLikeMlsNumber('RECIR2004622')).toBe(true)
        expect(looksLikeMlsNumber('MFRTB8412290')).toBe(true)
    })

    test('an address is not mistaken for one', () => {
        expect(looksLikeMlsNumber('18 Maple Grove Avenue')).toBe(false)
        expect(looksLikeMlsNumber('7913 Eudora LN')).toBe(false)
        expect(looksLikeMlsNumber('Toronto')).toBe(false)
        expect(looksLikeMlsNumber('')).toBe(false)
    })
})

describe('the cache keys', () => {
    test('one listing is one key regardless of casing or padding', () => {
        expect(listingKey(' c5839471 ')).toEqual(listingKey('C5839471'))
    })

    test('a query is normalised so spacing does not buy a second request', () => {
        expect(searchKey('  18   Maple Grove  ', 10)).toEqual(searchKey('18 Maple Grove', 10))
    })

    test('a different page size is a different key', () => {
        expect(searchKey('18 Maple Grove', 10)).not.toEqual(searchKey('18 Maple Grove', 25))
    })
})

describe('calls that never reach upstream', () => {
    test('an empty query returns an empty page without billing a request', async () => {
        const spy = jest.spyOn(globalThis, 'fetch')

        const result = await searchListings('   ')

        expect(result.listings).toEqual([])
        expect(result.count).toEqual(0)
        expect(spy).not.toHaveBeenCalled()

        spy.mockRestore()
    })

    test('an empty MLS number returns null without billing a request', async () => {
        const spy = jest.spyOn(globalThis, 'fetch')

        expect(await getListing('')).toBeNull()
        expect(spy).not.toHaveBeenCalled()

        spy.mockRestore()
    })
})

/*
 * Live calls. They hit Repliers, which bills per request — so the cache is
 * primed once here and every later assertion reads through it, and a re-run
 * within the 24h TTL costs nothing.
 */
describe('against the live Repliers API', () => {
    test('a detail lookup parses clean', async () => {
        await invalidateListing(CAPTURED_MLS)

        const listing = await getListing(CAPTURED_MLS)

        expect(listing).not.toBeNull()
        expect(listing?.mlsNumber).toEqual(CAPTURED_MLS)
        expect(typeof listing?.listPrice).toEqual('number')
        expect(listing?.address.city).toBeTruthy()
    }, 20_000)

    test('a second identical call is served from the cache, with no outbound request', async () => {
        // Cold, so the first call is known to be the billed one.
        await invalidateListing(CAPTURED_MLS)

        const spy = jest.spyOn(globalThis, 'fetch')

        const first = await getListing(CAPTURED_MLS)

        expect(spy).toHaveBeenCalledTimes(1)

        const second = await getListing(CAPTURED_MLS)

        expect(spy).toHaveBeenCalledTimes(1)
        expect(second).toEqual(first)

        spy.mockRestore()
    }, 20_000)

    test('a search returns results, and repeats hit the cache', async () => {
        await invalidateSearch(CAPTURED_STREET, 5)

        const spy = jest.spyOn(globalThis, 'fetch')

        const first = await searchListings(CAPTURED_STREET, 5)

        expect(spy).toHaveBeenCalledTimes(1)
        expect(first.listings.length).toBeGreaterThan(0)
        expect(first.listings[0].mlsNumber).toBeTruthy()

        const second = await searchListings(CAPTURED_STREET, 5)

        expect(spy).toHaveBeenCalledTimes(1)
        expect(second).toEqual(first)

        spy.mockRestore()
    }, 20_000)

    test('searching an MLS number routes to the detail endpoint', async () => {
        const result = await searchListings(CAPTURED_MLS, 5)

        expect(result.count).toEqual(1)
        expect(result.listings).toHaveLength(1)
        expect(result.listings[0].mlsNumber).toEqual(CAPTURED_MLS)
    }, 20_000)

    test('an MLS number that matches nothing is an empty answer, not an error', async () => {
        // Valid TRREB shape, and the sandbox holds no Ontario data at all.
        await invalidateListing('C5839471')

        expect(await getListing('C5839471')).toBeNull()
    }, 20_000)

    test('a wrong key is refused loudly rather than returning blanks', async () => {
        const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('{"message":"unauthorized"}', { status: 401 })
        )

        await invalidateListing(CAPTURED_MLS)

        await expect(getListing(CAPTURED_MLS)).rejects.toThrow(RepliersError)

        spy.mockRestore()

        // Left cold, so the next test is not served a poisoned entry.
        await invalidateListing(CAPTURED_MLS)
    })

    test('a response that no longer matches the schema throws instead of returning a blank listing', async () => {
        const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            // `listPrice` renamed upstream — exactly the drift that would
            // otherwise reach the fill engine as an empty line on a form.
            new Response(JSON.stringify({ ...listingFixture, listPrice: undefined }), { status: 200 })
        )

        await invalidateListing(CAPTURED_MLS)

        await expect(getListing(CAPTURED_MLS)).rejects.toThrow(/did not match/)

        spy.mockRestore()
        await invalidateListing(CAPTURED_MLS)
    })
})
