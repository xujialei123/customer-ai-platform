ALTER TABLE "conversations"
ADD COLUMN "summary" TEXT,
ADD COLUMN "summaryUpdatedAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "conversations_platform_platformConversationId_key";

CREATE UNIQUE INDEX "conversations_platform_shopId_platformConversationId_key"
ON "conversations"("platform", "shopId", "platformConversationId");
