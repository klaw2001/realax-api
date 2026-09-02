import type { NextFunction, Request, Response } from 'express'

import { isProduction } from '@/config/env'
import logger from '@/lib/logger'
import type { ErrorResponse } from '@/schemas/common'

/**
 * The last handler in the stack.
 *
 * Without it Express answers an unhandled throw with its own HTML page — a
 * stack trace in development, "Internal Server Error" markup in production.
 * Neither is JSON, so the frontend's `toApiError` cannot read either: it parses
 * the body for the `{ error, message }` envelope, fails, and falls back to the
 * status line. The agent sees "PUT /api/… failed (500)" and nobody learns
 * anything. Worse, the development page puts a stack trace — file paths, and
 * whatever an error message picked up on its way out — into a browser.
 *
 * So every failure that reaches here leaves as the same envelope every handled
 * failure already uses. One shape out of the API, whatever went wrong.
 */

/**
 * A 404 for a path no route matched.
 *
 * Mounted before the error handler and after every route. Express' own default
 * for an unmatched path is the same HTML page, so an app calling a URL that
 * moved would get the same unreadable answer as one that crashed.
 */
export const notFound = (_req: Request, res: Response) => {
    res.status(404).json({
        error: 'not_found',
        message: 'No such endpoint'
    } satisfies ErrorResponse)
}

/**
 * A malformed JSON body, as `body-parser` reports it.
 *
 * It throws before any handler runs, so this is the only place that can answer
 * one. 400 rather than 500 — the request is what is wrong.
 */
const isBodyParseError = (error: unknown): boolean =>
    error instanceof SyntaxError && 'body' in error && (error as { status?: number }).status === 400

/**
 * Turn anything thrown into the API's error envelope.
 *
 * Four arguments, including `next`, because that is how Express recognises an
 * error handler — removing the unused one silently turns this back into
 * ordinary middleware that never runs.
 */
export const errorHandler = (
    error: unknown,
    req: Request,
    res: Response,
    _next: NextFunction
) => {
    // Something already started writing — a stream, or a handler that answered
    // and then threw. Anything appended now would corrupt that response, so
    // hand it back to Express to close the connection.
    if (res.headersSent) {
        logger.error('error after response started', {
            method: req.method,
            path: req.path,
            name: error instanceof Error ? error.name : typeof error
        })

        return
    }

    if (isBodyParseError(error)) {
        res.status(400).json({
            error: 'invalid_json',
            message: 'The request body is not valid JSON'
        } satisfies ErrorResponse)

        return
    }

    // The message and stack are logged, never sent. An error thrown deep in a
    // fill or an MLS call can carry a client's name, a document key, or an
    // upstream URL with a key in it — none of which belongs in a browser.
    logger.error('unhandled error', {
        method: req.method,
        path: req.path,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    })

    res.status(500).json({
        error: 'internal_error',
        message: isProduction
            ? 'Something went wrong. This has been reported.'
            : // Locally the name is worth having in the browser — it is the
              // difference between "something went wrong" and
              // "SourceHashMismatchError", and it is a class name rather than
              // the message, so nothing a client typed can reach it.
              `Something went wrong: ${error instanceof Error ? error.name : 'unknown error'}. Check the server log.`
    } satisfies ErrorResponse)
}

export default errorHandler
