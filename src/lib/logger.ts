import winston from 'winston'

import { env, isProduction } from '@/config/env'

/**
 * The service's logger.
 *
 * JSON in production so a log aggregator can index the fields; a readable line
 * locally. Nothing here ever logs a secret, a session id, or an identity
 * document number — pass the id of a row, not its contents.
 *
 * The starter's `@core/services/LoggingService` is left alone; new code uses
 * this one, and the two do not need to be reconciled until the starter's
 * leftovers come out.
 */
const logger = winston.createLogger({
    level: isProduction ? 'info' : 'debug',
    format: isProduction
        ? winston.format.combine(winston.format.timestamp(), winston.format.json())
        : winston.format.combine(winston.format.colorize(), winston.format.simple()),
    transports: [
        new winston.transports.Console({
            // Jest reports on a closed stdout after the suite ends; a transport
            // still writing at that point crashes the runner.
            silent: env.NODE_ENV === 'test'
        })
    ]
})

export default logger
