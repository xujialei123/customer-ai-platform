-- @file scripts/init-db.sql
-- @module 数据库、共享包与交付
-- @description 创建 RAG 相关表：Wiki、Card、Graph、Gap 和向量索引。
-- @see 联动关注：KnowledgeStore 与向量维度配置。
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rag_knowledge_files (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL REFERENCES rag_knowledge_bases(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('uploaded','parsing','parsed','embedding','completed','failed')),
  chunk_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rag_knowledge_chunks (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL REFERENCES rag_knowledge_bases(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES rag_knowledge_files(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  page INTEGER,
  chunk_index INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rag_wiki_pages (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL REFERENCES rag_knowledge_bases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  faq JSONB NOT NULL DEFAULT '[]',
  keywords JSONB NOT NULL DEFAULT '[]',
  question_variants JSONB NOT NULL DEFAULT '[]',
  related_topics JSONB NOT NULL DEFAULT '[]',
  source_ids JSONB NOT NULL DEFAULT '[]',
  platform TEXT,
  shop_id TEXT,
  category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rag_knowledge_cards (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL REFERENCES rag_knowledge_bases(id) ON DELETE CASCADE,
  wiki_page_id TEXT REFERENCES rag_wiki_pages(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  answer TEXT,
  question_variants JSONB NOT NULL DEFAULT '[]',
  keywords JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  platform TEXT,
  shop_id TEXT,
  shop_name TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  related_card_ids JSONB NOT NULL DEFAULT '[]',
  source_type TEXT NOT NULL,
  source_id TEXT,
  source_name TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rag_knowledge_graph_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES rag_knowledge_cards(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES rag_knowledge_cards(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(from_id, to_id, relation)
);

CREATE TABLE IF NOT EXISTS rag_knowledge_gaps (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  reason TEXT NOT NULL,
  suggested_card_title TEXT NOT NULL,
  suggested_question_variants JSONB NOT NULL DEFAULT '[]',
  platform TEXT,
  shop_id TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kb_routes (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  kb_id TEXT NOT NULL REFERENCES rag_knowledge_bases(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_sessions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  external_user_name TEXT,
  last_message_at TIMESTAMPTZ,
  ai_reply_count INTEGER NOT NULL DEFAULT 0,
  need_human BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES customer_sessions(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system','human')),
  content TEXT NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS retrieval_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  kb_ids JSONB NOT NULL DEFAULT '[]',
  query TEXT NOT NULL,
  matched_chunks JSONB NOT NULL DEFAULT '[]',
  answer TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  need_human BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rpa_message_dedup (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  message_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_knowledge_chunks_kb_id ON rag_knowledge_chunks(kb_id);
CREATE INDEX IF NOT EXISTS idx_rag_knowledge_files_kb_id ON rag_knowledge_files(kb_id);
CREATE INDEX IF NOT EXISTS idx_kb_routes_platform_shop ON kb_routes(platform, shop_id);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_lookup ON customer_sessions(platform, shop_id, external_user_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_logs_session_id ON retrieval_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_rpa_message_dedup_hash ON rpa_message_dedup(message_hash);
CREATE INDEX IF NOT EXISTS idx_rag_knowledge_chunks_embedding ON rag_knowledge_chunks USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_rag_wiki_pages_kb_id ON rag_wiki_pages(kb_id);
CREATE INDEX IF NOT EXISTS idx_rag_cards_kb_id ON rag_knowledge_cards(kb_id);
CREATE INDEX IF NOT EXISTS idx_rag_cards_filters ON rag_knowledge_cards(platform, shop_id, category, enabled);
CREATE INDEX IF NOT EXISTS idx_rag_cards_embedding ON rag_knowledge_cards USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_rag_graph_from ON rag_knowledge_graph_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_rag_gaps_lookup ON rag_knowledge_gaps(platform, shop_id, category);
