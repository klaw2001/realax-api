import path from 'path'

import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import fileUpload from 'express-fileupload'
import cookieParser from 'cookie-parser'
import session from 'express-session'
import { PrismaSessionStore } from '@quixo3/prisma-session-store'

import { env, isProduction } from '@/config/env'
import prisma from '@/lib/prisma'
import requireAgent from '@/middleware/auth'
import { authRoutes, meRoutes } from '@/modules/auth/auth.routes'
import healthRoutes from '@/modules/health/health.routes'

const app = express()

app.set('port', env.PORT)

// Behind a proxy in production, so `secure` cookies are recognised as being
// sent over HTTPS rather than silently dropped.
if (isProduction) {
    app.set('trust proxy', 1)
}

app.use(express.static('public'))
app.use(bodyParser.json({ limit: '5mb' }))

// The frontend is a separate origin and will send a session cookie, so the
// allowed origin has to be explicit — `*` is invalid with credentials.
app.use(
    cors({
        origin: env.CORS_ORIGIN,
        credentials: true
    })
)
app.use(cookieParser())
app.use(
    fileUpload({ limits: { fileSize: 5 * 1024 * 1024 }, safeFileNames: false, abortOnLimit: true })
)

app.use(
    session({
        name: 'realax.sid',
        secret: env.SESSION_SECRET,
        // The store is authoritative; there is nothing to write back on a
        // request that did not touch the session.
        resave: false,
        // No cookie until something is actually stored in the session, so an
        // unauthenticated caller does not collect a session row per request.
        saveUninitialized: false,
        // Each authenticated request pushes the expiry out, so an agent working
        // through a transaction is not logged out mid-form.
        rolling: true,
        cookie: {
            httpOnly: true,
            // HTTPS only in production. `SameSite=None` is required there
            // because the app and the API are served from different hosts, and
            // it is only legal alongside `secure`.
            secure: isProduction,
            sameSite: isProduction ? 'none' : 'lax',
            maxAge: 12 * 60 * 60 * 1000
        },
        // Postgres-backed via Prisma. Sessions survive a restart, and Phase 0.5
        // can swap this one option for a Redis store without touching anything
        // else.
        store: new PrismaSessionStore(prisma, {
            // Prune expired rows every 10 minutes. Left off under test — the
            // timer would hold the Jest process open after the suite finishes.
            checkPeriod: env.NODE_ENV === 'test' ? undefined : 10 * 60 * 1000,
            dbRecordIdIsSessionId: true
        })
    })
)

app.use('/health', healthRoutes)

// Served so the frontend can run `gen:api` against a running dev server
// instead of reaching across repos for the file.
app.get('/openapi.json', (_req, res) => {
    res.sendFile(path.resolve(process.cwd(), 'openapi.json'))
})

// Public. Login has to be reachable without a session, and logout stays
// reachable so a client can clear stale state without first handling a 401.
app.use('/api/auth', authRoutes)

// Everything mounted below this line requires a session. New modules go here —
// a route is protected by where it sits, not by remembering to guard it.
app.use('/api', requireAgent)

app.use('/api/me', meRoutes)

export default app
