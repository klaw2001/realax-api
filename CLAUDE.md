# REALAX — API

Transaction automation for Ontario realtors. This repo is the backend:
Express + TypeScript. The frontend is a **separate repo** (`realax-app`,
Next.js + Vuexy) and talks to this service over HTTP only.

Build plan: `REALAX_BUILD_PLAN.md`. Work the phases in order.

## Stack — fixed

Node, TypeScript, Express, Prisma, PostgreSQL, Redis, Zod.
AWS S3 (`ca-central-1`), `pdf-lib`, Repliers (MLS), signNow (e-sign).

Structure: feature modules under `src/modules/`, shared clients under
`src/lib/`, third-party wrappers under `src/integrations/`, Zod contracts
under `src/schemas/`. Full tree in `REALAX_BUILD_PLAN.md` — follow it.
Anything we don't control (Repliers, OCR, signNow response shapes) lives
in `integrations/` so a vendor change touches one folder.

**Package manager: npm.** `package-lock.json` is the lockfile and is
committed. Do not run `pnpm` or `yarn` in this repo, and do not add a
second lockfile. (The frontend repo uses pnpm — that's intentional, they
are independent repos with no shared workspace.)

## This repo is the source of truth for the API contract

Zod schemas live in `src/schemas/`, annotated with
`@asteasolutions/zod-to-openapi`. After **any** change to a request or
response shape:

```bash
npm run gen:openapi     # regenerates openapi.json — commit it in the same commit
```

The frontend generates its types from that file. A schema change without a
regenerated `openapi.json` silently breaks the other repo. Treat them as
one unit of work.

## Rules

1. **Every third-party key lives here and only here.** Repliers, signNow,
   AWS, the database. The frontend never holds one. Several are billed per
   request or grant access to client identity documents.
2. **Never invent an external API response shape.** If a real captured
   Repliers or signNow response isn't available, stop and ask for one.
   Build the Zod schema from the response, not from documentation.
3. **One task per session.** Tasks in the plan are sized deliberately.
   Report acceptance criteria with command output, not a summary.
4. **Migrations are additive.** Ask before anything destructive.
5. Secrets only in `.env`. Never in code, never in logs.
6. Never log or put in an error message: client names, identity document
   numbers, or S3 keys for ID scans.
7. Cache every Repliers call in Redis, keyed by MLS number. They bill per
   request and the same address gets demoed repeatedly.

## Domain notes that trip people up

- **The OREA PDFs have no form fields.** They are print output; the blanks
  are dot-leader runs in the text layer. We fill by coordinate overlay
  from a curated template JSON in `forms/templates/`.
- **`pdf-lib` cannot parse the originals** until `qpdf --decrypt` has been
  run. `ignoreEncryption: true` is not sufficient — it skips the
  permission check but leaves the object streams encrypted.
- **Templates are version-pinned by SHA-256.** OREA revises forms and
  coordinates shift silently. Refuse to fill on a hash mismatch rather
  than producing a plausible-looking wrong document.
- **A template is two files merged.** `forms/templates/<code>.raw.json` is
  extractor output and regenerable; `<code>.names.json` is the hand-written
  curation naming each blank. `tools/curate_template.py <code>` merges them
  into `<code>.json`, which is the only one the service loads. A form with a
  `.raw.json` and no `.json` has geometry but no names and is not fillable —
  that is deliberate, not an oversight.
- **`kind` on a blank is not decoration.** `data` blanks are the agent's and
  the compliance gate checks them; `signature` and `signingDate` blanks are
  filled inside the e-sign session, and counting one as missing would block
  every transaction.
- **The compliance check runs before signing**, not after. Catching a
  missing field post-signature forces a re-sign loop.
- **Webhooks are the source of truth for signer state**, never the iframe
  redirect. Verify signatures; assume redelivery; make handlers idempotent
  by external event id.
- **Identity records are FINTRAC material.** Five-year retention, S3
  Object Lock, presigned reads only, never public.

## Commands

```bash
npm run dev
npm run typecheck        # must pass before any commit
npm test
npm run gen:openapi
npx prisma migrate dev

python3 tools/curate_template.py 100   # re-merge a curated template
npm run forms:seed                     # upload sources to S3, upsert FormTemplate
```
