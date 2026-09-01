// A cache outage must degrade, not fail. This suite points the client at a
// port with nothing behind it, so it exercises the path the application takes
// when Redis is genuinely down — which the happy-path suite cannot.

// Modules are re-imported per test with a different `REDIS_URL`, so the client
// under test is a fresh one rather than the connected singleton the other
// suites share.
const DEAD_URL = 'redis://127.0.0.1:6399'

const loadWithDeadRedis = async () => {
    process.env.REDIS_URL = DEAD_URL
    jest.resetModules()

    return import('../src/lib/redis')
}

describe('when Redis is unreachable', () => {
    // Each guarded operation gives up after 2s; a connect plus a read plus a
    // write is comfortably inside this.
    jest.setTimeout(30_000)

    test('cached falls through to the origin instead of hanging', async () => {
        const { cached, disconnect } = await loadWithDeadRedis()

        const origin = jest.fn(async () => ({ mlsNumber: 'C5839471' }))
        const value = await cached('test:outage:read', 60, origin)

        expect(value).toEqual({ mlsNumber: 'C5839471' })
        expect(origin).toHaveBeenCalledTimes(1)

        await disconnect()
    })

    test('ping reports down rather than throwing', async () => {
        const { ping, disconnect } = await loadWithDeadRedis()

        // This is what makes `/health` answer 503 with a body naming Redis,
        // rather than timing out and saying nothing at all.
        expect(await ping()).toEqual(false)

        await disconnect()
    })
})
