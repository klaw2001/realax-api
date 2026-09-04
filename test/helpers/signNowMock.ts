// Imported for its side effect, before anything that reads the environment.
//
// `src/config/env.ts` parses `process.env` once, at import, so the provider and
// the webhook secret have to be set before anything imports it — and a
// side-effect import is the only ordering ES modules guarantee.
//
// Both are set explicitly rather than left to the default. `--setupFiles
// dotenv/config` has already loaded the developer's real `.env` by this point,
// which on a machine with signNow credentials would otherwise mean tests
// signing fixtures with the production webhook secret and, worse, a test run
// that behaves differently depending on whose laptop it is on.
process.env.SIGNNOW_PROVIDER = 'mock'
process.env.SIGNNOW_WEBHOOK_SECRET = 'signing-test-secret-not-the-real-one'

export {}
