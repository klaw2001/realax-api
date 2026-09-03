# REALAX — Technical Implementation Plan

Working document for Claude Code. Phase boundaries match the client-facing
plan given to Darren, so progress reported to him maps 1:1 to what is built.

| Client phase | Client-facing name | Technical scope |
|---|---|---|
| Phase 0 | *(not shown to client)* | Repo, schema, auth, storage, deploy |
| Phase 1 | Agent profile setup → property information | Profile, transaction type, MLS lookup |
| Phase 2 | Automatic document completion + compliance check | Field mapper, fill engine, compliance gate |
| Phase 3 | E-sign → testing → live pilot | signNow, webhooks, audit trail, pilot |

---

## Stack (fixed — do not substitute)

**Backend** — Node + TypeScript + Express starter
- PostgreSQL via Prisma (Neon in prod)
- Zod for all boundary validation (external APIs, request bodies)
- Redis for caching
- AWS S3 (`ca-central-1`) for all file storage
- `pdf-lib` for form filling

**Frontend** — Next.js + Vuexy template
- **MUI**, per Vuexy. Do NOT introduce shadcn/ui, Tailwind utility classes,
  or a second component library. Vuexy ships its own theme; extend it
  rather than working around it.
- TanStack Query for server state. No global store unless a real need appears.

**Third party** — Repliers (MLS), signNow (e-sign), AWS Textract
(`AnalyzeID`, `ca-central-1` — identity documents are read in the region
they are stored in)

### Architecture note

Frontend never calls Repliers, signNow, S3, or the database directly.
Every external key lives in the Express service. The Next.js app talks
only to our own API. This is not negotiable — several of these keys are
billed per request or grant access to client identity documents.

### Repo layout — two independent repos

Held side by side in a plain parent folder (`realax/`) that is **not** a
git repo. Each repo has its own `CLAUDE.md`.

The trees below are the target shape. The starters already contain some
of this — adapt toward it rather than restructuring wholesale on day one.

```
realax-api/                     ← Express starter, own git repo
  prisma/
    schema.prisma
    migrations/
    seed.ts
  forms/
    sources/                    decrypted blank OREA PDFs
    templates/                  curated field-map JSON (100.json, …)
  tools/
    extract_template.py
  src/
    index.ts                    listen() only
    app.ts                      express app — importable by tests
    config/
      env.ts                    Zod-validated process.env, fails fast on boot
    lib/
      prisma.ts  redis.ts  s3.ts  logger.ts
    middleware/
      auth.ts  validate.ts  error.ts  rateLimit.ts
    schemas/                    Zod — the API contract, OpenAPI-annotated
      agent.ts  transaction.ts  property.ts  party.ts
      form.ts   compliance.ts  signing.ts   common.ts
    modules/
      auth/         auth.routes.ts  auth.controller.ts  auth.service.ts
      agent/
      property/
      party/
      transaction/
      forms/
        forms.routes.ts
        template.service.ts     load + SHA-256 verify
        mapper.service.ts       domain → merged field object
        fill.service.ts         pdf-lib overlay
        compliance.service.ts
      signing/
        signing.routes.ts  signnow.client.ts  webhook.controller.ts
      documents/
    integrations/
      repliers/   client.ts  schema.ts  cache.ts
      ocr/        provider.ts  textract.client.ts
    openapi/
      registry.ts  generate.ts
  test/
  openapi.json                  generated, committed
```

```
realax-app/                     ← Next.js + Vuexy starter, own git repo
  src/
    @core/  @layouts/  @menu/   Vuexy internals — do not edit
    configs/
      themeConfig.ts            extend the theme here, not by overriding @core
    app/                        thin route files only
      (blank-layout-pages)/
        login/page.tsx
      (dashboard)/
        layout.tsx
        profile/page.tsx
        transactions/
          page.tsx
          new/page.tsx
          [id]/
            page.tsx
            property/page.tsx
            parties/page.tsx
            forms/page.tsx
            review/page.tsx     compliance gate — a route, not a modal
            signing/page.tsx
    views/                      Vuexy convention — page content composes here
      profile/
      transactions/
        TransactionList.tsx
        PropertySearch.tsx      the stagger-autofill moment
        PartyForm.tsx
        ComplianceReview.tsx
    components/                 small shared presentational pieces
    hooks/
      useTransaction.ts  useProperty.ts
    lib/
      api.ts                    fetch wrapper, credentials, error mapping
      queryClient.ts
    types/
      api.d.ts                  GENERATED — never hand-edited
```

**Why these splits:**

- `app.ts` apart from `index.ts` so tests import the app without binding
  a port.
- `config/env.ts` validates the environment at boot — a missing
  `AWS_KMS_KEY_ID` fails on startup, not at the first ID upload.
- `integrations/` sits outside `modules/` because those are the shapes we
  don't control. When Repliers changes a response or the OCR vendor is
  swapped, the blast radius is one folder.
- `forms/sources/` and `forms/templates/` are version-linked by hash;
  keeping them adjacent makes drift visible.
- `app/` vs `views/` is Vuexy's own pattern. Keep route files thin. Do not
  invent a parallel structure alongside it.

### Keeping types in sync across two repos

There is no shared package, so the contract has to be generated rather
than imported. **The API is the source of truth.** Zod schemas in
`realax-api/src/schemas/` are annotated with `@asteasolutions/zod-to-openapi`
and emitted to `openapi.json`, which the frontend consumes:

```bash
# realax-api (npm) — after any schema change
npm run gen:openapi       # writes openapi.json, commit it

# realax-app (pnpm) — regenerate the typed client
pnpm gen:api              # openapi-typescript <url|file> -o src/types/api.d.ts
```

> The two repos use different package managers on purpose: the API is on
> npm (`package-lock.json`), the frontend on pnpm (`pnpm-lock.yaml`).
> They share no workspace, so this costs nothing — but never add a second
> lockfile to either repo.

Rules that make this hold:
- `src/types/api.d.ts` is **generated output**. Never hand-edit it; never
  hand-write a duplicate interface anywhere else in `web/`.
- A schema change in the API is not done until `openapi.json` is
  regenerated and committed. Treat it as part of the same commit.
- During Phase 0/1 the frontend can point `gen:api` at the running dev
  server (`http://localhost:4000/openapi.json`) instead of a file.

This costs one command per schema change and buys compile-time errors in
the frontend when the API shape moves. Without it, two repos drift within
a fortnight.

> If this friction gets annoying later, the escape hatch is publishing
> `@realax/contracts` to GitHub Packages as a private package. Don't do
> that yet — it adds auth and release overhead for a one-person team.

---

## Working agreement for Claude Code

1. **One task per session.** Tasks below are sized deliberately. Do not
   chain them.
2. **One branch per phase**, one commit per task, conventional commits.
3. **Never invent an external API shape.** If the Repliers or signNow
   response shape is unknown, stop and ask for a real captured response.
   Build the Zod schema from that, not from documentation.
4. **Every task lists acceptance criteria.** Do not report a task complete
   until each one passes. Run the verification command and paste output.
5. **Do not scope-creep.** If a task suggests an obvious adjacent
   improvement, note it at the end of the session and move on.
6. **Migrations are additive.** No destructive migration without asking.
7. Secrets only in `.env`. Never in code, never in the frontend bundle,
   never logged.

---

# Phase 0 — Foundation

Not visible to Darren. Everything else stands on it.

### 0.1 — Repo setup and the contract pipeline

Two repos, initialised independently.

**`realax-api`** — strict TS config, scripts for `dev`, `build`, `lint`,
`typecheck`, `test`, `gen:openapi`. Install
`@asteasolutions/zod-to-openapi`. Create one real schema
(`schemas/health.ts`) and wire the generator end to end so the pattern is
established before there is anything complicated to generate.

**`realax-app`** — CORS-aware API client with the base URL from
`NEXT_PUBLIC_API_URL`, a `gen:api` script running `openapi-typescript`,
and TanStack Query set up. Confirm the Vuexy theme renders untouched.

*Acceptance:* both repos start independently. `npm run gen:openapi` in the
API writes `openapi.json`; `pnpm gen:api` in the web app regenerates
`src/types/api.d.ts`; the web app calls `/health` through the generated
type and typecheck passes in both. Deliberately break a field name
in the API schema, regenerate both, and confirm the frontend fails to
compile — that failure is the whole point of the pipeline.

### 0.2 — Data model

Full Prisma schema. The demo's single `Transaction` with a `Json` blob is
retired here — the field shapes are known now.

```prisma
model Agent {
  id             String   @id @default(cuid())
  email          String   @unique
  name           String
  recoNumber     String?
  phone          String?
  brokerageId    String?
  brokerage      Brokerage? @relation(fields: [brokerageId], references: [id])
  transactions   Transaction[]
  createdAt      DateTime @default(now())
}

model Brokerage {
  id          String  @id @default(cuid())
  name        String
  address     String
  phone       String?
  agents      Agent[]
  // Seeded preset table — Phase 1 profile autofill
}

model Party {
  id            String   @id @default(cuid())
  fullLegalName String
  email         String?
  phone         String?
  identityRecords IdentityRecord[]
  roles         TransactionParty[]
}

model IdentityRecord {
  id            String   @id @default(cuid())
  partyId       String
  party         Party    @relation(fields: [partyId], references: [id])
  documentType  String   // drivers_licence | passport | …
  documentNumber String  // encrypted at rest
  expiryDate    DateTime?
  verifiedAt    DateTime
  verifiedMethod String  // FINTRAC method used
  s3Key         String
  // Retained 5 years. Object Lock applies to the S3 object.
  createdAt     DateTime @default(now())
}

model Property {
  id               String  @id @default(cuid())
  mlsNumber        String?
  address          String
  city             String
  province         String  @default("ON")
  postalCode       String?
  frontingSide     String?
  frontingStreet   String?
  frontage         String?
  depth            String?
  legalDescription String?
  listPrice        Int?
  taxes            String?
  transactions     Transaction[]
}

enum TransactionType { LISTING PURCHASE LEASE }
enum TransactionStatus { DRAFT COMPLIANCE_PENDING READY_TO_SIGN OUT_FOR_SIGNATURE COMPLETED CANCELLED }

model Transaction {
  id          String   @id @default(cuid())
  type        TransactionType
  status      TransactionStatus @default(DRAFT)
  agentId     String
  agent       Agent    @relation(fields: [agentId], references: [id])
  propertyId  String?
  property    Property? @relation(fields: [propertyId], references: [id])
  parties     TransactionParty[]
  forms       TransactionForm[]
  envelopes   SigningEnvelope[]
  documents   Document[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

enum PartyRole { BUYER SELLER SPOUSE WITNESS }

model TransactionParty {
  id            String @id @default(cuid())
  transactionId String
  transaction   Transaction @relation(fields: [transactionId], references: [id])
  partyId       String
  party         Party  @relation(fields: [partyId], references: [id])
  role          PartyRole
  signingOrder  Int?
  @@unique([transactionId, partyId, role])
}

model FormTemplate {
  id           String @id @default(cuid())
  formCode     String   // "100", "200a"
  revision     String   // "May 2026"
  sourceSha256 String
  sourceS3Key  String
  fieldMap     Json     // output of extract_template.py, curated
  forms        TransactionForm[]
  @@unique([formCode, revision])
}

enum FormStatus { DRAFT FILLED SIGNED }

model TransactionForm {
  id             String @id @default(cuid())
  transactionId  String
  transaction    Transaction @relation(fields: [transactionId], references: [id])
  formTemplateId String
  formTemplate   FormTemplate @relation(fields: [formTemplateId], references: [id])
  values         Json     // merged object fed to the fill engine
  filledS3Key    String?
  status         FormStatus @default(DRAFT)
  checks         ComplianceCheck[]
}

model ComplianceCheck {
  id                String @id @default(cuid())
  transactionFormId String
  transactionForm   TransactionForm @relation(fields: [transactionFormId], references: [id])
  missingFields     Json
  overrides         Json    // [{ field, reason, agentId, at }]
  passed            Boolean
  checkedAt         DateTime @default(now())
}

model SigningEnvelope {
  id            String @id @default(cuid())
  transactionId String
  transaction   Transaction @relation(fields: [transactionId], references: [id])
  provider      String @default("signnow")
  externalId    String @unique
  status        String
  auditCertS3Key String?
  events        SignerEvent[]
  createdAt     DateTime @default(now())
}

model SignerEvent {
  id         String @id @default(cuid())
  envelopeId String
  envelope   SigningEnvelope @relation(fields: [envelopeId], references: [id])
  eventType  String
  payload    Json
  receivedAt DateTime @default(now())
}

model Document {
  id            String @id @default(cuid())
  transactionId String
  transaction   Transaction @relation(fields: [transactionId], references: [id])
  kind          String   // id_scan | filled_form | signed_form | audit_cert
  s3Key         String
  sha256        String
  createdAt     DateTime @default(now())
}

model AuditLog {
  id         String   @id @default(cuid())
  actorId    String?
  action     String
  entityType String
  entityId   String
  metadata   Json?
  createdAt  DateTime @default(now())
  @@index([entityType, entityId])
}
```

*Acceptance:* migration applies to a clean DB. Seed script creates one
agent, one brokerage, one transaction. `prisma studio` shows the relations.

### 0.3 — Auth

Session-based auth on the Express side, agent accounts only. Login,
logout, `GET /me`. Middleware attaching `req.agent`. Frontend route guard.

*Do not build* multi-tenancy, roles, or brokerage admin. One agent, one
account.

*Acceptance:* unauthenticated requests to any `/api/*` route except
`/auth/*` and `/health` return 401.

### 0.4 — S3 + storage service

`realax-api/src/lib/s3.ts`. Wraps: `putObject`, `getSignedUrl`
(short TTL), `headObject`. `ca-central-1`, SSE-KMS, versioning on,
Object Lock configured on the bucket.

Key convention:
```
transactions/{txId}/ids/{partyId}/{docType}.jpg
transactions/{txId}/forms/{formCode}/filled.pdf
transactions/{txId}/forms/{formCode}/signed.pdf
transactions/{txId}/audit/{envelopeId}.pdf
```

Nothing is ever public. Every read goes through a presigned URL issued by
our API after an auth check.

*Acceptance:* integration test uploads, presigns, fetches, and confirms a
direct unsigned GET returns 403.

### 0.5 — Redis + deploy skeleton

Redis client with a typed `cached(key, ttl, fn)` helper. Health endpoint
checking DB, Redis, S3. Both apps deployed and talking to each other.

*Acceptance:* `/health` returns 200 with all three green from the
deployed environment.

---

# Phase 1 — Agent profile → property information

**Client-facing:** "Agent profile setup through property information."

### 1.1 — Agent profile

CRUD for the agent's own profile: name, RECO number, phone, brokerage.
Brokerage is a select from the seeded preset table — picking one fills
address and phone. (OCR of the registration certificate is deliberately
deferred; presets now, OCR later.)

*Acceptance:* profile persists, brokerage selection populates the
dependent fields, reload retains everything.

### 1.2 — Transaction type picker

UI shows all three types: Listing, Purchase, Lease. **Only Listing is
wired live.** Purchase and Lease render and are visibly marked as coming
next — this is a deliberate scoping decision, do not implement them.

*Acceptance:* selecting Listing creates a `DRAFT` transaction. The other
two are visible and non-functional.

### 1.3 — Repliers client

`realax-api/src/integrations/repliers/client.ts` — `searchListings(q)`,
`getListing(mlsNumber)`. Key server-side only. Redis cache keyed by MLS
number, 24h TTL (Repliers bills per request). Zod-parse every response;
fail loudly on schema mismatch rather than silently returning blanks.

MLS number pattern for TRREB is a letter followed by 7–8 digits
(e.g. `C5839471`). If the search param doesn't handle both address and
MLS, detect the pattern and route accordingly.

> **Blocker:** the current key returns sandbox data, not live TRREB.
> Build against it, but every demo caveat about data realism traces here.

*Acceptance:* search returns results, detail parses clean, second
identical call hits cache (assert no outbound request).

### 1.4 — Property entry + autofill

Search box → debounced (300ms) results → select → property fields
populate with a stagger animation. This is the demo moment; make it
visible. Manual override on every field — MLS data is a starting point,
not gospel.

*Acceptance:* address in, populated property form out, fields editable,
save persists a `Property` linked to the transaction.

### 1.5 — Parties

Add buyers and sellers to a transaction: full legal name, email, phone,
role. No ID scan on this screen — that is 2.5, and it hangs off the party
rather than off this form.

*Acceptance:* multiple parties per transaction, correct roles, editable.

---

# Phase 2 — Document completion + compliance check

**Client-facing:** "Automatic document completion and compliance check."

### 2.1 — Form template ingestion

Port the prototype into the codebase:

```
qpdf --decrypt blank.pdf source.pdf          # pdf-lib cannot parse the
                                             # RC4-encrypted originals
python tools/extract_template.py source.pdf 100 > forms/templates/100.json
# then curate: name every blank
```

Seed `FormTemplate` rows from the curated JSON, upload sources to S3.

*Acceptance:* Form 100 template row exists with 105 blanks; `sourceSha256`
matches the S3 object.

> Curating the remaining blanks in each form is manual work, not a coding
> task. Page 1 of Form 100 is done (27 of 105).

### 2.2 — Field mapper

`realax-api/src/modules/forms/mapper.service.ts`. Takes a transaction with its property,
parties, and agent profile; emits one flat merged object. The mapper is
the only thing that knows how domain data becomes form values.

Build it to accept a **generic merged object** so OCR output and manual
entry plug in later without a rewrite. Same output feeds both the fill
engine and the compliance checker — one schema, two consumers.

*Acceptance:* unit tests. A fully populated transaction produces every
key the Form 100 template names; a sparse one produces the rest as
`undefined` rather than throwing.

### 2.3 — Fill engine

Port `fill.mjs`. Loads template + source PDF, verifies `sourceSha256`
(refuse to fill on mismatch — OREA revisions move coordinates silently),
draws values, handles multi-line blocks and auto-shrink, writes the filled
PDF to S3, returns `{ filledS3Key, filled[], missing[] }`.

*Acceptance:* a seeded transaction produces a downloadable filled Form 100.
Visual check against the reference render. A tampered source PDF is
rejected with a clear error.

### 2.4 — Compliance gate

The `missing` array from 2.3 is the check — it comes free. Gate runs
**before** signing invites go out, not after. This differs from how Darren
originally described it; the reason is that catching a missing field after
signing forces a re-sign loop.

**Override policy — decided: there is no override.** A failed check is a
hard block. The form is not filled, no partial PDF is produced, and
nothing advances to signing. Darren's call, and it settles the open
question that used to sit here.

`ComplianceCheck.overrides` stays on the model and is written as an empty
list on every check — an honest record that nothing was waived, and no
migration to add back if the policy ever loosens. Nothing writes to it.
The gate is a pure function and every failure carries a stable `field`,
so an override would be one filter over the failure list before `passed`
is computed; no shape here has to change for that.

*Acceptance:* incomplete transaction blocks with a per-field list, and no
path past it. Complete transaction passes and moves to `READY_TO_SIGN`.

### 2.5 — ID scan — **backend built**

**Vendor: AWS Textract `AnalyzeID`.** `ca-central-1` availability was
confirmed before the integration was written; identity documents are
FINTRAC material and do not leave the region, including to be read.

Upload → S3 → OCR → extract name, document number, expiry → create
`IdentityRecord` → reuse on future transactions for the same party.

Shipped:

- `src/integrations/ocr/provider.ts` — the vendor-neutral boundary:
  `OcrProvider`, `ScanRequest`, `ScannedIdentity`, `OcrError`
  (`unavailable` = 502 and retryable, `unreadable` = a better photo).
  Kept even though the vendor is chosen — it is what keeps a vendor's
  field names out of the domain model.
- `src/integrations/ocr/textract.client.ts` — the one implementation.
- `src/modules/identity/` — service, controller, routes, mounted at
  `/api/transactions/:id/parties/:partyId/identity` below the session
  guard. `POST` reads a document, `POST .../scans/:scanId/confirm` turns a
  reading into a record, `GET` lists a party's records.
- `test/identity-scan.test.ts`. The suite stubs the provider; nothing in
  `npm test` calls Textract.

Order is store → read → record, so the `IdentityRecord` is provably about
the object under Object Lock rather than about bytes that were in memory.
`documentNumber` is encrypted (`IDENTITY_ENCRYPTION_KEY`) the moment it
exists and is never returned, logged, or put in an error message — the
API answers `documentNumberOnFile`, not the number. Records key on the
*person*, not the transaction row, which is what makes the reuse work.

**Reading is not verifying — the two are separate calls.** `POST` stores the
image, reads it, and writes an `IdentityScan`: a proposal, holding the
encrypted number and the file's digest, that has verified nobody. The
`IdentityRecord` is created only by the confirm call, from the values the
agent confirmed rather than the ones the model returned. Nothing is
auto-accepted, and a scan nobody confirms stays a scan rather than becoming
a verification that never happened.

The reason is the vendor: AnalyzeID is trained on US identity documents and
an Ontario licence is not one it was verified against, so any field can be
wrong or absent while the model reports it confidently. A pending scan is a
table rather than a Redis key because `lib/redis.ts` is a cache whose
contents must stay reproducible from Postgres, and reproducing a reading
means paying for a second Textract call.

Name and address corrections go to the `Party` through its own PATCH, which
is where the OREA form reads them from. Confirming twice is a 409: one
photograph is one verification.

---

# Phase 3 — E-sign, testing, pilot

**Client-facing:** "E-sign through testing and live pilot."

### 3.1 — signNow integration

OAuth 2.0. Documents built from templates so the field schema is defined
once and reused. Field schema splits in two:
- **pre-send fields** — agent-filled, validated by the compliance gate
- **signing fields** — signature, initials, date; supplied in session,
  not validated pre-send

Signing is **sequential**, one signer at a time.

> API access is a separate signNow plan on annual commitment. Run the free
> trial first; commit once real invite volume per deal is known.

*Acceptance:* envelope created from a filled Form 100, first signer
receives an invite.

### 3.2 — Embedded signing

Embedded flow, not a redirect.

*Acceptance:* signer completes in-app; the next signer is invited
automatically.

### 3.3 — Webhooks

**Webhooks are the source of truth for signer state — not the iframe
redirect.** The redirect fires on browser events that don't reliably mean
the document was signed.

Signature-verify every payload. Persist to `SignerEvent`. Idempotent by
external event id — assume redelivery.

*Acceptance:* replaying the same webhook twice produces one state change.
An unsigned payload is rejected.

### 3.4 — Completion + audit trail

On completion: store signed PDF and signNow audit certificate against the
transaction, both under Object Lock. Transaction → `COMPLETED`.

> **Open:** confirm signNow's audit certificate satisfies Ontario
> provincial e-signature requirements for these document types. Some land
> documents may still require witnessing.

*Acceptance:* completed transaction exposes signed PDF + audit cert via
presigned URLs. Attempting to overwrite either object fails.

### 3.5 — Pilot hardening

Structured logging, Sentry, rate limits on the Repliers proxy, backup
verification, a runbook. Then one real transaction end to end with Darren.

---

## Environment

```bash
# realax-api/.env
DATABASE_URL=
DIRECT_URL=
REDIS_URL=
SESSION_SECRET=
REPLIERS_API_KEY=
AWS_REGION=ca-central-1
AWS_S3_BUCKET=
AWS_KMS_KEY_ID=
SIGNNOW_CLIENT_ID=
SIGNNOW_CLIENT_SECRET=
SIGNNOW_WEBHOOK_SECRET=
OCR_PROVIDER=textract    # Phase 2.5
OCR_REGION=ca-central-1
IDENTITY_ENCRYPTION_KEY=  # 32 bytes, hex or base64 — IdentityRecord.documentNumber
CORS_ORIGIN=

# realax-app/.env.local
NEXT_PUBLIC_API_URL=
```

---

## Explicitly out of scope

Do not build these without an explicit instruction:

- Purchase and Lease transaction flows (UI stubs only — see 1.2)
- TransactionDesk / Lone Wolf API integration (partner approval pending;
  if it lands, it is an **export** target, not a replacement for the fill
  engine)
- Multi-tenancy, brokerage admin, agent teams
- Comparables, listing browser, CRM features
- Mobile apps
- Any second UI library alongside MUI

## Known blockers

| Blocker | Blocks | Owner |
|---|---|---|
| Repliers key is sandbox, not live TRREB | 1.3 demo realism | Darren |
| Remaining form blanks uncurated | 2.1 | Klaw (manual) |
| signNow API plan not purchased | 3.1 | Klaw |
| Provincial e-signature validity | 3.4 | Darren / legal |
