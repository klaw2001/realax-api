'use strict'

import http from 'http'

// Imported before the app so an invalid environment fails on boot rather than
// at the first request that needs a variable.
import { env } from '@/config/env'
import app from '@/app'
import { ocrProvider } from '@/integrations/ocr'
import logger from '@/lib/logger'
import prisma from '@/lib/prisma'
import { disconnect as disconnectRedis } from '@/lib/redis'

// Named once, at boot, because it is not always the production one: `azure`
// is the free development reader and `mock` reads fixtures and verifies
// nobody. `env.ts` refuses anything but Textract under NODE_ENV=production, so
// this line is not the guard — it is how anyone reading the logs of a
// non-production deploy knows which reader produced the readings in it.
logger.info('identity document reader', {
    provider: ocrProvider().name,
    environment: env.NODE_ENV
})

const server = http.createServer(app)

const port = env.PORT

server.listen(port, '0.0.0.0')

const onError = (error: NodeJS.ErrnoException & { syscall?: string }) => {
    if (error.syscall !== 'listen') { throw error }

    // handle specific listen errors with friendly messages
    switch (error.code) {
        case 'EACCES':
            console.error(`Port ${port} requires elevated privileges`)
            process.exit(1)
            break
        case 'EADDRINUSE':
            console.error(`Port ${port} is already in use`)
            process.exit(1)
            break
        default:
            throw error
    }
}

const onListening = () => {
    const addr = server.address()
    const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + port

    console.log('Server Listening on ' + bind)
}

server.on('error', onError)
server.on('listening', onListening)


/**
 * Stop accepting connections, then close the clients.
 *
 * In that order: a Prisma or Redis client closed while a request is still in
 * flight turns a normal deploy into a handful of 500s.
 */
const shutdown = (signal: string) => {
    logger.info('shutting down', { signal })

    server.close(async () => {
        await Promise.allSettled([disconnectRedis(), prisma.$disconnect()])
        process.exit(0)
    })

    // A hung connection must not hold the process open indefinitely; the
    // orchestrator would SIGKILL it anyway, and this exits cleanly first.
    setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
