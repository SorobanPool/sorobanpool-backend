-- AlterTable
ALTER TABLE "Pool" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "advancePaid" DECIMAL(38,7) NOT NULL DEFAULT 0,
ADD COLUMN     "allocationPending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN     "filledAt" TIMESTAMP(3),
ADD COLUMN     "finalUnitPrice" DECIMAL(38,7),
ADD COLUMN     "offerHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "pickedUnits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundsPushed" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "currentUnitPrice" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "Commitment" DROP COLUMN "refundClaimed",
ADD COLUMN     "refundClaimed" DECIMAL(38,7) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Dispute" ADD COLUMN     "openedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "PendingPool" (
    "id" TEXT NOT NULL,
    "hubHash" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "organizerAddress" TEXT NOT NULL,
    "hubAddress" TEXT NOT NULL,
    "hubContact" TEXT NOT NULL,
    "pickupWindow" JSONB NOT NULL,
    "fillDeadline" TIMESTAMP(3) NOT NULL,
    "shareSlug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingPool_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingPool_hubHash_key" ON "PendingPool"("hubHash");

-- CreateIndex
CREATE UNIQUE INDEX "PendingPool_shareSlug_key" ON "PendingPool"("shareSlug");

