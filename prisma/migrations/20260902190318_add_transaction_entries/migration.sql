-- AlterTable
ALTER TABLE "Party" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "TransactionEntries" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "agreementDate" DATE,
    "purchasePrice" DECIMAL(12,2),
    "purchasePriceWords" TEXT,
    "depositTiming" TEXT,
    "depositAmount" DECIMAL(12,2),
    "depositAmountWords" TEXT,
    "depositHolder" TEXT,
    "schedulesList" TEXT,
    "irrevocabilityBoundParty" TEXT,
    "irrevocabilityTime" TEXT,
    "irrevocabilityDate" DATE,
    "completionDate" DATE,
    "titleSearchDate" DATE,
    "noticesSellerFax" TEXT,
    "noticesBuyerFax" TEXT,
    "chattelsIncluded" TEXT[],
    "fixturesExcluded" TEXT[],
    "rentalItems" TEXT[],
    "hstTreatment" TEXT,
    "propertyPresentUse" TEXT,
    "coopBrokerageName" TEXT,
    "coopBrokerageTel" TEXT,
    "coopBrokerageSalesperson" TEXT,
    "sellerLawyerName" TEXT,
    "sellerLawyerAddress" TEXT,
    "sellerLawyerEmail" TEXT,
    "sellerLawyerTel" TEXT,
    "sellerLawyerFax" TEXT,
    "buyerLawyerName" TEXT,
    "buyerLawyerAddress" TEXT,
    "buyerLawyerEmail" TEXT,
    "buyerLawyerTel" TEXT,
    "buyerLawyerFax" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionEntries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransactionEntries_transactionId_key" ON "TransactionEntries"("transactionId");

-- AddForeignKey
ALTER TABLE "TransactionEntries" ADD CONSTRAINT "TransactionEntries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
