-- AlterTable
ALTER TABLE "TransactionEntries" ADD COLUMN     "additionalSchedulesList" TEXT,
ADD COLUMN     "buyerRequirementsGeographicLocation" TEXT,
ADD COLUMN     "buyerRequirementsPropertyType" TEXT,
ADD COLUMN     "commencementDate" DATE,
ADD COLUMN     "commencementTime" TEXT,
ADD COLUMN     "commissionAlternative" TEXT,
ADD COLUMN     "commissionLease" TEXT,
ADD COLUMN     "commissionPercent" TEXT,
ADD COLUMN     "designatedRepresentatives" TEXT,
ADD COLUMN     "expiryDate" DATE,
ADD COLUMN     "holdoverPeriodDays" INTEGER;
