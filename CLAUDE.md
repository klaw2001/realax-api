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
  permission check but leaves the object streams encrypted. So each form is
  two committed PDFs: the OREA download in `forms/sources/`, which the
  blanks were measured on and which the form library publishes to S3, and a
  decrypted derivative in `forms/sources/decrypted/<code>.pdf`, which is the
  one the fill engine opens. Both are pinned — `sourceSha256` and
  `fillSourceSha256` — and the extractor reads the original, so the two
  cannot drift apart unnoticed.
- **Templates are version-pinned by SHA-256.** OREA revises forms and
  coordinates shift silently. Refuse to fill on a hash mismatch rather
  than producing a plausible-looking wrong document.
- **A template is two files merged.** `forms/templates/<code>.raw.json` is
  extractor output and regenerable; `<code>.names.json` is the hand-written
  curation naming each blank. `tools/curate_template.py <code>` merges them
  into `<code>.json`, which is the only one the service loads. A form with a
  `.raw.json` and no `.json` has geometry but no names and is not fillable —
  that is deliberate, not an oversight.
- **`flow` on a blank is the multi-line hint.** Blanks sharing a `flow` are
  the ruled continuation lines of one field — the four under CHATTELS
  INCLUDED — and one value wraps across them at fill time, where the font
  metrics are. It is curated rather than inferred from the `.lineN` names:
  an address block is printed on two lines too, but its second line is the
  city and postal code, not the overflow of the first.
- **`optional` on a blank is how a form says the gate must not require it.**
  Every `data` blank is required by default; the gate holds no opinion of its
  own about which OREA blanks matter, so the exception is recorded in the
  curation next to the name. Form 801 is why it exists — it prints the times
  the *listing* brokerage received and presented the offer, and a co-operating
  agent filling it has neither, so without the flag that form could never pass
  for anyone. Marking one is a statement about the paper: have the PDF open.
- **`requiredParties` on a template is how a form overrides the gate's idea of
  who must be on the transaction.** The gate's table is keyed by transaction
  type and says a purchase has a buyer and a seller. Form 371 is signed at
  onboarding, before there is a seller to have an agreement with, so it declares
  `["BUYER"]` and the gate follows the form. Every other curation says nothing
  and keeps the type's answer. Consequence worth knowing: 371 is fillable and
  downloadable, but not sendable on a transaction that already has a seller —
  `placementsForParties` has no line for them and refuses rather than dropping a
  signer.
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

qpdf --decrypt "forms/sources/<the OREA file>.pdf" \
     forms/sources/decrypted/100.pdf   # once per revision, then commit it
python3 tools/curate_template.py 100   # re-merge a curated template
npm run forms:seed                     # upload sources to S3, upsert FormTemplate
```
