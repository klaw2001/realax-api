import { createClient, type RedisClientType } from 'redis'

import { env, isProduction } from '@/config/env'
import logger from '@/lib/logger'

/**
 * The service's only Redis client.
 *
 * Redis is a cache, not a store of record. Repliers bills per request, so a
 * miss costs money rather than correctness — but nothing that only exists in
 * Redis may ever be needed to answer a request. Every value written here is
 * reproducible from Postgres or from the upstream API.
 */
const client: RedisClientType = createClient({
    url: env.REDIS_URL,
    socket: {
        // A cache that cannot be reached must not become a request that hangs.
        // Five seconds, then the call fails and the caller falls through to the
        // origin.
        connectTimeout: 5_000,

        // Backs off to a 3s ceiling and keeps trying. Returning an Error here
        // instead would stop reconnection permanently and leave the process
        // running with a dead client.
        reconnectStrategy: retries => Math.min(retries * 200, 3_000)
    }
})

/** How long any single cache operation may take before the caller gives up. */
const OPERATION_TIMEOUT_MS = 2_000

let lastErrorLoggedAt = 0

// `error` has no default listener; without this an unreachable Redis emits an
// unhandled 'error' event and takes the process down.
//
// Throttled: the reconnect strategy retries every few seconds for as long as
// Redis is down, and an unthrottled log turns a cache outage into gigabytes.
client.on('error', error => {
    const now = Date.now()

    if (now - lastErrorLoggedAt < 30_000) {
        return
    }

    lastErrorLoggedAt = now
    logger.error('redis client error', { message: (error as Error).message })
})

/**
 * Bound an operation in time.
 *
 * Redis reconnects forever by design, which means a call made while it is down
 * would otherwise wait forever. Every caller here treats a cache as optional,
 * so a timeout is the correct answer rather than a hang — most of all on
 * `/health`, whose entire job is to answer.
 */
function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
    return Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`redis ${label} timed out after ${OPERATION_TIMEOUT_MS}ms`)),
                OPERATION_TIMEOUT_MS
            )

            // Nothing should stay alive on the event loop for a race that the
            // other side already won.
            timer.unref()
        })
    ])
}

let connecting: Promise<unknown> | null = null

/**
 * Connect on first use rather than at import.
 *
 * Importing this module must not bind a socket — `app.ts` is imported by the
 * test suite, and a connection opened at import time keeps Jest alive after
 * the last assertion.
 */
export async function getRedis(): Promise<RedisClientType> {
    if (!client.isOpen && !connecting) {
        connecting = client.connect().finally(() => {
            connecting = null
        })
    }

    if (connecting) {
        await connecting
    }

    return client
}

/**
 * Round-trip the connection. Used by the health endpoint; returns `false`
 * rather than throwing, because "Redis is down" is a health *result*, not a
 * failure of the health check.
 */
export async function ping(): Promise<boolean> {
    try {
        const redis = await withTimeout(getRedis(), 'connect')

        return (await withTimeout(redis.ping(), 'ping')) === 'PONG'
    } catch (error) {
        logger.warn('redis ping failed', { message: (error as Error).message })

        return false
    }
}

/**
 * Read-through cache.
 *
 *   const listing = await cached(`repliers:listing:${mls}`, 86_400, () =>
 *       repliers.getListing(mls)
 *   )
 *
 * `fn` is the source of truth and runs on a miss. It also runs when Redis is
 * unreachable or holds a value that no longer parses — a cache outage degrades
 * to the uncached path, it does not surface as an error to the caller.
 *
 * Values are stored as JSON, so `T` must survive a `JSON.parse(JSON.stringify(…))`
 * round trip. A `Date` comes back as a string; parse it in the caller's Zod
 * schema rather than trusting the type parameter.
 */
export async function cached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
        throw new Error('Cache TTL must be a positive whole number of seconds')
    }

    try {
        const redis = await withTimeout(getRedis(), 'connect')
        const hit = await withTimeout(redis.get(key), 'get')

        if (hit !== null) {
            return JSON.parse(hit) as T
        }
    } catch (error) {
        // A miss caused by an outage is still a miss. Logged at warn because it
        // means every subsequent call is hitting a metered upstream.
        logger.warn('cache read failed, falling through to origin', {
            key,
            message: (error as Error).message
        })
    }

    const value = await fn()

    // `undefined` does not survive JSON, and caching a null result would pin an
    // upstream failure in place for the whole TTL.
    if (value === undefined || value === null) {
        return value
    }

    try {
        const redis = await withTimeout(getRedis(), 'connect')

        await withTimeout(
            redis.set(key, JSON.stringify(value), { expiration: { type: 'EX', value: ttlSeconds } }),
            'set'
        )
    } catch (error) {
        // The caller already has its answer. A failed write only costs the next
        // caller a second origin request.
        logger.warn('cache write failed', { key, message: (error as Error).message })
    }

    return value
}

/** Drop one key — after a write that invalidates whatever it held. */
export async function invalidate(key: string): Promise<void> {
    try {
        const redis = await withTimeout(getRedis(), 'connect')

        await withTimeout(redis.del(key), 'del')
    } catch (error) {
        // Left to expire on its own TTL. Loud in production, where a stale
        // value can outlive the change that should have cleared it.
        const log = isProduction ? logger.error : logger.warn

        log('cache invalidation failed', { key, message: (error as Error).message })
    }
}

/** Close the connection. For test teardown and graceful shutdown only. */
export async function disconnect(): Promise<void> {
    if (client.isOpen) {
        await client.close()
    }
}

export default client
