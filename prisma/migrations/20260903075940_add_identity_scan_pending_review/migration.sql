-- CreateTable
CREATE TABLE "IdentityScan" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "s3Key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "recordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdentityScan_transactionId_partyId_idx" ON "IdentityScan"("transactionId", "partyId");

-- AddForeignKey
ALTER TABLE "IdentityScan" ADD CONSTRAINT "IdentityScan_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityScan" ADD CONSTRAINT "IdentityScan_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
