-- AlterTable
ALTER TABLE "TransactionEntries" ADD COLUMN     "coopBrokerageAddress" TEXT,
ADD COLUMN     "coopBrokerageAddress2" TEXT,
ADD COLUMN     "coopBrokerageComments" TEXT,
ADD COLUMN     "coopBrokerageFax" TEXT,
ADD COLUMN     "coopCommissionAmount" TEXT,
ADD COLUMN     "coopCommissionTerms" TEXT,
ADD COLUMN     "listingBrokerageAddress" TEXT,
ADD COLUMN     "listingBrokerageAddress2" TEXT,
ADD COLUMN     "listingBrokerageFax" TEXT,
ADD COLUMN     "sellerBrokerageCommentsMultiple" TEXT,
ADD COLUMN     "sellerBrokerageCommentsSingle" TEXT;
