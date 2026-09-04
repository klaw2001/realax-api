-- Signing envelope columns for phase 3 (3.1 + 3.3).
--
-- Written by hand rather than taken verbatim from `prisma migrate diff`, which
-- emits `ADD COLUMN ... NOT NULL` with no default for `dedupeKey` and
-- `updatedAt`. That form fails outright on a table with rows. Both tables are
-- empty today — nothing has ever referenced these models — but rule 4 says
-- migrations are additive, and backfilling costs three extra statements.

-- SigningEnvelope -----------------------------------------------------------

ALTER TABLE "SigningEnvelope" ADD COLUMN "transactionFormId" TEXT;
ALTER TABLE "SigningEnvelope" ADD COLUMN "activeFormId" TEXT;
ALTER TABLE "SigningEnvelope" ADD COLUMN "signers" JSONB;

-- Backfilled from createdAt so existing rows carry a sensible value, then made
-- NOT NULL. Prisma manages it from here via @updatedAt.
ALTER TABLE "SigningEnvelope" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "SigningEnvelope" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "SigningEnvelope" ALTER COLUMN "updatedAt" SET NOT NULL;

-- SignerEvent ---------------------------------------------------------------

-- The idempotency key. Backfilled from the row's own id, which is unique by
-- construction, so the unique index below can be created without collisions.
ALTER TABLE "SignerEvent" ADD COLUMN "dedupeKey" TEXT;
UPDATE "SignerEvent" SET "dedupeKey" = "id" WHERE "dedupeKey" IS NULL;
ALTER TABLE "SignerEvent" ALTER COLUMN "dedupeKey" SET NOT NULL;

-- Indexes -------------------------------------------------------------------

-- At most one envelope out for signature per form. Postgres allows many NULLs
-- under a unique constraint, so a terminal envelope clearing activeFormId
-- releases the form. This is what makes a double-clicked Send impossible at the
-- database rather than merely unlikely.
CREATE UNIQUE INDEX "SigningEnvelope_activeFormId_key" ON "SigningEnvelope"("activeFormId");

CREATE UNIQUE INDEX "SignerEvent_dedupeKey_key" ON "SignerEvent"("dedupeKey");

-- Postgres does not index foreign keys automatically and Prisma does not add
-- one; both of these are read on every webhook and every envelope listing.
CREATE INDEX "SigningEnvelope_transactionId_idx" ON "SigningEnvelope"("transactionId");
CREATE INDEX "SignerEvent_envelopeId_idx" ON "SignerEvent"("envelopeId");

-- Foreign keys --------------------------------------------------------------

ALTER TABLE "SigningEnvelope" ADD CONSTRAINT "SigningEnvelope_transactionFormId_fkey"
  FOREIGN KEY ("transactionFormId") REFERENCES "TransactionForm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SigningEnvelope" ADD CONSTRAINT "SigningEnvelope_activeFormId_fkey"
  FOREIGN KEY ("activeFormId") REFERENCES "TransactionForm"("id") ON DELETE SET NULL ON UPDATE CASCADE;
