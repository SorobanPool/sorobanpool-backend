-- AlterTable
ALTER TABLE "Offer" ADD COLUMN "priceOutlierFlag" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Offer_priceOutlierFlag_status_idx" ON "Offer"("priceOutlierFlag", "status");
