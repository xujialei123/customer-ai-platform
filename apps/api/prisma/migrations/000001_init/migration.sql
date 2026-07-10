-- @file apps/api/prisma/migrations/000001_init/migration.sql
-- @module API 入口与基础设施
-- @description 初始化业务表和 pgvector 扩展。
-- @see 联动关注：已执行迁移不要重写。
-- 启用 pgvector 扩展，用于 RAG 向量检索
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "shops" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "platformShopId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "platform_accounts" (
  "id" TEXT PRIMARY KEY,
  "platform" TEXT NOT NULL,
  "shopId" TEXT NOT NULL REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "accountName" TEXT,
  "config" JSONB NOT NULL DEFAULT '{}',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "conversations" (
  "id" TEXT PRIMARY KEY,
  "platform" TEXT NOT NULL,
  "shopId" TEXT NOT NULL REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "platformConversationId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "customerName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "conversations_platform_platformConversationId_key"
ON "conversations"("platform", "platformConversationId");

CREATE TABLE "messages" (
  "id" TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "platform" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "messageType" TEXT NOT NULL DEFAULT 'text',
  "content" TEXT,
  "raw" JSONB NOT NULL DEFAULT '{}',
  "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "knowledge_sources" (
  "id" TEXT PRIMARY KEY,
  "shopId" TEXT NOT NULL REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "content" TEXT,
  "fileUrl" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "knowledge_chunks" (
  "id" TEXT PRIMARY KEY,
  "sourceId" TEXT NOT NULL REFERENCES "knowledge_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "shopId" TEXT NOT NULL REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "content" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "embedding" vector(1536),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- IVFFLAT 索引适合数据量较大后使用；MVP 可以先保留。
CREATE INDEX "knowledge_chunks_embedding_idx"
ON "knowledge_chunks" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

CREATE TABLE "reply_drafts" (
  "id" TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "messageId" TEXT NOT NULL REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "riskLevel" TEXT NOT NULL DEFAULT 'low',
  "reason" TEXT,
  "ragContext" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
