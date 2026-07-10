-- @file apps/api/prisma/migrations/000002_conversation_context/migration.sql
-- @module API 入口与基础设施
-- @description 为会话表增加摘要上下文字段。
-- @see 联动关注：MessageService 上下文维护。
ALTER TABLE "conversations"
ADD COLUMN "summary" TEXT,
ADD COLUMN "summaryUpdatedAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "conversations_platform_platformConversationId_key";

CREATE UNIQUE INDEX "conversations_platform_shopId_platformConversationId_key"
ON "conversations"("platform", "shopId", "platformConversationId");
