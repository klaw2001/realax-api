// Imported for its side effect, before anything that reads the environment.
//
// `src/config/env.ts` parses `process.env` once, at import, and the identity
// router decides whether the demo route exists at the same moment. A test that
// needs the route absent therefore has to set the flag before the app is
// imported, and a side-effect import is the only ordering ES modules
// guarantee — an assignment in the test body runs after every import has
// already been hoisted and evaluated.
//
// Set explicitly rather than left to the default, so this file does not depend
// on what an earlier test file in the same worker left behind.
process.env.DEMO_MODE = 'false'

export {}
