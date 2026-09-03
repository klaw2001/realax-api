// Imported for its side effect, before anything that reads the environment.
//
// `src/config/env.ts` parses `process.env` once, at import. A test that needs
// the demo route mounted therefore has to set the flag before the app is
// imported, and a side-effect import is the only ordering ES modules
// guarantee — an assignment in the test body runs after every import has
// already been hoisted and evaluated.
process.env.DEMO_MODE = 'true'

export {}
