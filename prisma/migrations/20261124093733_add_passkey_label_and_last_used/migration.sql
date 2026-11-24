-- AlterTable
ALTER TABLE "Passkey" ADD COLUMN "label" TEXT,
ADD COLUMN "lastUsedAt" TIMESTAMP(3);
