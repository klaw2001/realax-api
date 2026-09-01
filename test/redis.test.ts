import { randomUUID } from 'crypto'

import { cached, disconnect, getRedis, invalidate, ping } from '../src/lib/redis'

// An integration test against a real Redis. The properties worth checking —
// that a second call does not reach the origin, that a TTL is actually set —
// are properties of the server, and a mock would confirm all of them while
// the cache silently did nothing.

// Namespaced per run so a concurrent run cannot collide, and nothing here
// touches a key the application uses.
const KEY = `test:cache:${randomUUID()}`

afterAll(async () => {
    await invalidate(KEY)
    await disconnect()
})

describe('the cache', () => {
    test('ping reaches the server', async () => {
        expect(await ping()).toEqual(true)
    })

    test('runs the origin once, then serves from the cache', async () => {
        const origin = jest.fn(async () => ({ mlsNumber: 'C5839471', listPrice: 899_000 }))

        const first = await cached(KEY, 60, origin)
        const second = await cached(KEY, 60, origin)

        expect(first).toEqual({ mlsNumber: 'C5839471', listPrice: 899_000 })
        expect(second).toEqual(first)

        // The whole point: Repliers bills per request, so the second call must
        // not have reached it.
        expect(origin).toHaveBeenCalledTimes(1)
    })

    test('sets the TTL it was given', async () => {
        const redis = await getRedis()
        const ttl = await redis.ttl(KEY)

        // Not a bare `toBeGreaterThan(0)` — a key with no expiry reads as -1,
        // which is the failure this is here to catch.
        expect(ttl).toBeGreaterThan(0)
        expect(ttl).toBeLessThanOrEqual(60)
    })

    test('invalidate drops the key and the next call hits the origin again', async () => {
        await invalidate(KEY)

        const origin = jest.fn(async () => ({ mlsNumber: 'C5839471', listPrice: 925_000 }))
        const value = await cached(KEY, 60, origin)

        expect(origin).toHaveBeenCalledTimes(1)
        expect(value.listPrice).toEqual(925_000)
    })

    test('does not cache a null result', async () => {
        const nullKey = `${KEY}:null`
        const origin = jest.fn(async () => null)

        await cached(nullKey, 60, origin)
        await cached(nullKey, 60, origin)

        // Caching a null would pin an upstream failure in place for the whole
        // TTL — every caller would see the outage long after it ended.
        expect(origin).toHaveBeenCalledTimes(2)
    })

    test('rejects a nonsensical TTL', async () => {
        await expect(cached(KEY, 0, async () => 'x')).rejects.toThrow('positive whole number')
    })
})
