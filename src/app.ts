import path from 'path'

import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import fileUpload from 'express-fileupload'
import cookieParser from 'cookie-parser'
import session from 'express-session'
import { PrismaSessionStore } from '@quixo3/prisma-session-store'

import { crossSiteCookies, env } from '@/config/env'
import prisma from '@/lib/prisma'
import requireAgent from '@/middleware/auth'
import { errorHandler, notFound } from '@/middleware/error'
import agentRoutes from '@/modules/agent/agent.routes'
import { authRoutes, meRoutes } from '@/modules/auth/auth.routes'
import dashboardRoutes from '@/modules/dashboard/dashboard.routes'
import healthRoutes from '@/modules/health/health.routes'
import { transactionEntriesRoutes } from '@/modules/entries/entries.routes'
import { transactionFormRoutes } from '@/modules/forms/forms.routes'
import { partyIdentityRoutes, transactionIdentityRoutes } from '@/modules/identity/identity.routes'
import { transactionPartyRoutes } from '@/modules/party/party.routes'
import { transactionSigningRoutes } from '@/modules/signing/signing.routes'
import { signingWebhookRoutes } from '@/modules/signing/webhook.routes'
import { propertyRoutes, transactionPropertyRoutes } from '@/modules/property/property.routes'
import transactionRoutes from '@/modules/transaction/transaction.routes'

const app = express()

app.set('port', env.PORT)

// Behind a TLS-terminating proxy wherever the cookie is cross-site, so `secure`
// cookies are recognised as being sent over HTTPS rather than silently dropped.
if (crossSiteCookies) {
    app.set('trust proxy', 1)
}

app.use(express.static('public'))

// signNow signs the *bytes* it sent, so the HMAC has to be computed over the
// unparsed body. `bodyParser.json` consumes the stream, and by the time a
// handler runs the original bytes are gone — re-serialising `req.body` gives a
// different byte sequence and therefore a different digest.
//
// Path-scoped, and mounted ABOVE the JSON parser: body-parser marks a consumed
// request with `req._body` (read.js:46) and `json()` returns early when it is
// set (json.js:102), so the JSON parser skips this one path and every other
// route keeps the identical parser chain. The alternative — a `verify`
// callback on the global parser — would retain a Buffer copy of every request
// body in the application, up to the 5 MB limit, to serve one endpoint.
//
// The 2 MB limit is lower than the global one because a callback is a few
// kilobytes. An oversized one raises `PayloadTooLargeError`, which
// `errorHandler` answers 500 — a 5xx, which signNow retries and which never
// costs us the subscription.
app.use('/webhooks/signnow', express.raw({ type: '*/*', limit: '2mb' }))

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
            // `SameSite=None` wherever the app and the API are served from
            // different hosts, and it is only legal alongside `secure` — so the
            // two move together off one flag rather than off the environment
            // name. See `crossSiteCookies` in `config/env.ts`.
            secure: crossSiteCookies,
            sameSite: crossSiteCookies ? 'none' : 'lax',
            // Host-only unless a parent domain is named. The app's route guard
            // runs on the frontend's own server and can only read cookies the
            // browser sent *there*, so a two-host deploy has to name the domain
            // both hosts share. See `COOKIE_DOMAIN` in `config/env.ts`.
            domain: env.COOKIE_DOMAIN,
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

// Above the session guard, and deliberately outside `/api`: signNow has no
// session and never will. It authenticates by HMAC over the raw body, which
// the route does for itself. Mounted under `/api` it would 401 every callback,
// and 30 of those in an hour unsubscribes the webhook.
app.use('/webhooks/signnow', signingWebhookRoutes)

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

// Also under `/api/me`, and in its own module: the dashboard is an aggregate
// over transactions, compliance and identity, and belongs to none of them.
app.use('/api/me', dashboardRoutes)
app.use('/api/agent', agentRoutes)
app.use('/api/transactions', transactionRoutes)

// Mounted apart from the transaction router rather than inside it: the property
// module owns these handlers, and a route lives in the module that owns it.
app.use('/api/transactions/:id/property', transactionPropertyRoutes)
app.use('/api/transactions/:id/parties', transactionPartyRoutes)
app.use('/api/transactions/:id/identity', transactionIdentityRoutes)
app.use('/api/transactions/:id/parties/:partyId/identity', partyIdentityRoutes)
app.use('/api/transactions/:id/entries', transactionEntriesRoutes)
app.use('/api/transactions/:id/forms', transactionFormRoutes)
app.use('/api/transactions/:id/signing', transactionSigningRoutes)
app.use('/api/properties', propertyRoutes)

// Last, and in this order. `notFound` catches a path no route matched;
// `errorHandler` catches everything thrown by the routes above it. Both answer
// with the same `{ error, message }` envelope every handler already uses, so
// the frontend client reads one shape whatever happened — rather than Express'
// HTML stack page, which it cannot parse and which puts file paths in a
// browser. Nothing may be mounted below them: middleware added after an error
// handler never runs.
app.use(notFound)
app.use(errorHandler)

export default app
