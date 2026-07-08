-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Lang" AS ENUM ('EN', 'PCM', 'HA', 'YO', 'IG');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'LIVE', 'EXPIRED', 'TAKEN_DOWN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "displayName" TEXT,
    "language" "Lang" NOT NULL DEFAULT 'EN',
    "walletAddress" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "verHash" TEXT,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","role")
);

-- CreateTable
CREATE TABLE "Passkey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Passkey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpChallenge" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraderProfile" (
    "userId" TEXT NOT NULL,
    "market" TEXT,
    "state" TEXT NOT NULL,
    "lga" TEXT NOT NULL,
    "cluster" TEXT,

    CONSTRAINT "TraderProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "SupplierProfile" (
    "userId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "cacNumber" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "lga" TEXT NOT NULL,
    "categories" TEXT[],
    "deliveryAreas" JSONB NOT NULL,
    "bankName" TEXT,
    "bankAccountMasked" TEXT,
    "kybStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "kybRecordId" TEXT,

    CONSTRAINT "SupplierProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "VerificationRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brand" TEXT,
    "description" TEXT NOT NULL,
    "unitLabel" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "perishable" BOOLEAN NOT NULL DEFAULT false,
    "images" TEXT[],
    "tiersNgn" JSONB NOT NULL,
    "tiersUsdc" JSONB NOT NULL,
    "fxQuoteId" TEXT NOT NULL,
    "moq" INTEGER NOT NULL,
    "maxUnits" INTEGER NOT NULL,
    "maxPerMember" INTEGER NOT NULL,
    "leadTimeHours" INTEGER NOT NULL,
    "deliveryAreas" JSONB NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "offerHash" TEXT NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pool" (
    "id" BIGINT NOT NULL,
    "offerId" TEXT NOT NULL,
    "organizerAddress" TEXT NOT NULL,
    "supplierAddress" TEXT NOT NULL,
    "hubAddress" TEXT NOT NULL,
    "hubContact" TEXT NOT NULL,
    "hubHash" TEXT NOT NULL,
    "pickupWindow" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "totalUnits" INTEGER NOT NULL DEFAULT 0,
    "receivedUnits" INTEGER,
    "currentTierIdx" INTEGER NOT NULL DEFAULT 0,
    "currentUnitPrice" DECIMAL(38,7) NOT NULL,
    "fillDeadline" TIMESTAMP(3) NOT NULL,
    "escrowBalance" DECIMAL(38,7) NOT NULL DEFAULT 0,
    "frozenAmount" DECIMAL(38,7) NOT NULL DEFAULT 0,
    "shareSlug" TEXT NOT NULL,
    "lastEventLedger" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commitment" (
    "poolId" BIGINT NOT NULL,
    "memberAddress" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "paid" DECIMAL(38,7) NOT NULL,
    "allocatedUnits" INTEGER,
    "refundDue" DECIMAL(38,7),
    "refundClaimed" BOOLEAN NOT NULL DEFAULT false,
    "pickedUp" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Commitment_pkey" PRIMARY KEY ("poolId","memberAddress")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" BIGINT NOT NULL,
    "poolId" BIGINT NOT NULL,
    "openerAddress" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "claimedUnits" INTEGER NOT NULL,
    "claimedAmount" DECIMAL(38,7) NOT NULL,
    "state" TEXT NOT NULL,
    "outcome" JSONB,
    "arbiterAddress" TEXT,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "lastEventLedger" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "poolId" BIGINT,
    "disputeId" BIGINT,
    "kind" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bond" (
    "supplierAddress" TEXT NOT NULL,
    "total" DECIMAL(38,7) NOT NULL,
    "reserved" DECIMAL(38,7) NOT NULL,
    "lastEventLedger" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Bond_pkey" PRIMARY KEY ("supplierAddress")
);

-- CreateTable
CREATE TABLE "AnchorTransfer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "anchorTxId" TEXT NOT NULL,
    "amountNgn" DECIMAL(38,2),
    "amountUsdc" DECIMAL(38,7),
    "status" TEXT NOT NULL,
    "poolId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnchorTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxQuote" (
    "id" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "rate" DECIMAL(38,10) NOT NULL,
    "sources" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainEvent" (
    "id" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "contract" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ChainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexerCursor" (
    "id" TEXT NOT NULL,
    "lastLedger" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SponsorUsage" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SponsorUsage_pkey" PRIMARY KEY ("userId","day")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_walletAddress_key" ON "User"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Passkey_credentialId_key" ON "Passkey"("credentialId");

-- CreateIndex
CREATE INDEX "OtpChallenge_phone_createdAt_idx" ON "OtpChallenge"("phone", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshHash_key" ON "Session"("refreshHash");

-- CreateIndex
CREATE INDEX "VerificationRecord_userId_idx" ON "VerificationRecord"("userId");

-- CreateIndex
CREATE INDEX "Offer_status_category_idx" ON "Offer"("status", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Pool_shareSlug_key" ON "Pool"("shareSlug");

-- CreateIndex
CREATE INDEX "Pool_state_fillDeadline_idx" ON "Pool"("state", "fillDeadline");

-- CreateIndex
CREATE INDEX "Dispute_state_slaDueAt_idx" ON "Dispute"("state", "slaDueAt");

-- CreateIndex
CREATE INDEX "ChainEvent_ledger_idx" ON "ChainEvent"("ledger");

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passkey" ADD CONSTRAINT "Passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraderProfile" ADD CONSTRAINT "TraderProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProfile" ADD CONSTRAINT "SupplierProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

