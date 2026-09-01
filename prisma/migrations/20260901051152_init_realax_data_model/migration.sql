-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('LISTING', 'PURCHASE', 'LEASE');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('DRAFT', 'COMPLIANCE_PENDING', 'READY_TO_SIGN', 'OUT_FOR_SIGNATURE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PartyRole" AS ENUM ('BUYER', 'SELLER', 'SPOUSE', 'WITNESS');

-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('DRAFT', 'FILLED', 'SIGNED');

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "recoNumber" TEXT,
    "phone" TEXT,
    "brokerageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brokerage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT,

    CONSTRAINT "Brokerage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Party" (
    "id" TEXT NOT NULL,
    "fullLegalName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityRecord" (
    "id" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "verifiedMethod" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "mlsNumber" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "province" TEXT NOT NULL DEFAULT 'ON',
    "postalCode" TEXT,
    "frontingSide" TEXT,
    "frontingStreet" TEXT,
    "frontage" TEXT,
    "depth" TEXT,
    "legalDescription" TEXT,
    "listPrice" INTEGER,
    "taxes" TEXT,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'DRAFT',
    "agentId" TEXT NOT NULL,
    "propertyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionParty" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "role" "PartyRole" NOT NULL,
    "signingOrder" INTEGER,

    CONSTRAINT "TransactionParty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormTemplate" (
    "id" TEXT NOT NULL,
    "formCode" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "sourceS3Key" TEXT NOT NULL,
    "fieldMap" JSONB NOT NULL,

    CONSTRAINT "FormTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionForm" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "formTemplateId" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "filledS3Key" TEXT,
    "status" "FormStatus" NOT NULL DEFAULT 'DRAFT',

    CONSTRAINT "TransactionForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceCheck" (
    "id" TEXT NOT NULL,
    "transactionFormId" TEXT NOT NULL,
    "missingFields" JSONB NOT NULL,
    "overrides" JSONB NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SigningEnvelope" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'signnow',
    "externalId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "auditCertS3Key" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SigningEnvelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignerEvent" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sys_module" (
    "module_id" SERIAL NOT NULL,
    "module_key" VARCHAR(255),
    "module_name" VARCHAR(255),
    "module_status" BOOLEAN NOT NULL DEFAULT true,
    "module_created_by" VARCHAR(25),
    "module_updated_by" VARCHAR(25),
    "module_created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "module_updated_at" TIMESTAMP(3) NOT NULL,
    "module_archived" BOOLEAN NOT NULL DEFAULT false,
    "module_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "sys_module_pkey" PRIMARY KEY ("module_id")
);

-- CreateTable
CREATE TABLE "roles" (
    "role_id" SERIAL NOT NULL,
    "role_key" VARCHAR(255),
    "role_name" VARCHAR(255),
    "role_status" BOOLEAN NOT NULL DEFAULT true,
    "role_created_by" VARCHAR(25),
    "role_updated_by" VARCHAR(25),
    "role_created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "role_updated_at" TIMESTAMP(3) NOT NULL,
    "role_archived" BOOLEAN NOT NULL DEFAULT false,
    "role_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("role_id")
);

-- CreateTable
CREATE TABLE "module_role_map" (
    "mrm_id" SERIAL NOT NULL,
    "mrm_module_id" INTEGER NOT NULL,
    "mrm_role_id" INTEGER NOT NULL,
    "mrm_read" BOOLEAN NOT NULL DEFAULT false,
    "mrm_write" BOOLEAN NOT NULL DEFAULT false,
    "mrm_status" BOOLEAN NOT NULL DEFAULT true,
    "mrm_created_by" VARCHAR(25),
    "mrm_updated_by" VARCHAR(25),
    "mrm_created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mrm_updated_at" TIMESTAMP(3) NOT NULL,
    "mrm_archived" BOOLEAN NOT NULL DEFAULT false,
    "mrm_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "module_role_map_pkey" PRIMARY KEY ("mrm_id")
);

-- CreateTable
CREATE TABLE "users" (
    "user_id" SERIAL NOT NULL,
    "user_email" VARCHAR(255) NOT NULL,
    "user_mobile" TEXT NOT NULL,
    "user_password" VARCHAR(255) NOT NULL,
    "user_first_name" VARCHAR(255) NOT NULL,
    "user_last_name" VARCHAR(255) NOT NULL,
    "user_role_id" INTEGER,
    "user_status" BOOLEAN NOT NULL DEFAULT true,
    "user_created_by" VARCHAR(25),
    "user_updated_by" VARCHAR(25),
    "user_created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_updated_at" TIMESTAMP(3) NOT NULL,
    "user_archived" BOOLEAN NOT NULL DEFAULT false,
    "user_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_email_key" ON "Agent"("email");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionParty_transactionId_partyId_role_key" ON "TransactionParty"("transactionId", "partyId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "FormTemplate_formCode_revision_key" ON "FormTemplate"("formCode", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "SigningEnvelope_externalId_key" ON "SigningEnvelope"("externalId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "users_user_email_key" ON "users"("user_email");

-- CreateIndex
CREATE UNIQUE INDEX "users_user_mobile_key" ON "users"("user_mobile");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_brokerageId_fkey" FOREIGN KEY ("brokerageId") REFERENCES "Brokerage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityRecord" ADD CONSTRAINT "IdentityRecord_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionParty" ADD CONSTRAINT "TransactionParty_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionParty" ADD CONSTRAINT "TransactionParty_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionForm" ADD CONSTRAINT "TransactionForm_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionForm" ADD CONSTRAINT "TransactionForm_formTemplateId_fkey" FOREIGN KEY ("formTemplateId") REFERENCES "FormTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceCheck" ADD CONSTRAINT "ComplianceCheck_transactionFormId_fkey" FOREIGN KEY ("transactionFormId") REFERENCES "TransactionForm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningEnvelope" ADD CONSTRAINT "SigningEnvelope_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignerEvent" ADD CONSTRAINT "SignerEvent_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "SigningEnvelope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "module_role_map" ADD CONSTRAINT "module_role_map_mrm_module_id_fkey" FOREIGN KEY ("mrm_module_id") REFERENCES "sys_module"("module_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "module_role_map" ADD CONSTRAINT "module_role_map_mrm_role_id_fkey" FOREIGN KEY ("mrm_role_id") REFERENCES "roles"("role_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_user_role_id_fkey" FOREIGN KEY ("user_role_id") REFERENCES "roles"("role_id") ON DELETE SET NULL ON UPDATE CASCADE;
