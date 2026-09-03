-- DropForeignKey
ALTER TABLE "IdentityScan" DROP CONSTRAINT "IdentityScan_partyId_fkey";

-- AlterTable
ALTER TABLE "IdentityScan" ALTER COLUMN "partyId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "IdentityScan" ADD CONSTRAINT "IdentityScan_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
