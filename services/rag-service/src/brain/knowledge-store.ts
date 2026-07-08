import pg from 'pg';
import { nanoid } from 'nanoid';
import { env } from '../config/env.js';
import type { KnowledgeCard, KnowledgeGap, KnowledgeGraphEdge, WikiPage } from './types.js';

function arrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function mapCard(row: Record<string, any>): KnowledgeCard {
  return {
    id: row.id,
    kbId: row.kb_id,
    wikiPageId: row.wiki_page_id ?? undefined,
    title: row.title,
    content: row.content,
    answer: row.answer ?? undefined,
    questionVariants: arrayValue(row.question_variants),
    keywords: arrayValue(row.keywords),
    tags: arrayValue(row.tags),
    platform: row.platform ?? undefined,
    shopId: row.shop_id ?? undefined,
    shopName: row.shop_name ?? undefined,
    category: row.category,
    relatedCardIds: arrayValue(row.related_card_ids),
    sourceType: row.source_type,
    sourceId: row.source_id ?? undefined,
    sourceName: row.source_name ?? undefined,
    priority: row.priority,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export class KnowledgeStore {
  pool = new pg.Pool({ connectionString: env.DATABASE_URL });

  async saveWikiPage(page: WikiPage): Promise<void> {
    await this.pool.query(`INSERT INTO rag_wiki_pages
      (id,kb_id,title,summary,content,faq,keywords,question_variants,related_topics,source_ids,platform,shop_id,category,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,summary=EXCLUDED.summary,content=EXCLUDED.content,
      faq=EXCLUDED.faq,keywords=EXCLUDED.keywords,question_variants=EXCLUDED.question_variants,
      related_topics=EXCLUDED.related_topics,platform=EXCLUDED.platform,shop_id=EXCLUDED.shop_id,
      category=EXCLUDED.category,updated_at=EXCLUDED.updated_at`, [
      page.id, page.kbId, page.title, page.summary, page.content, JSON.stringify(page.faq), JSON.stringify(page.keywords),
      JSON.stringify(page.questionVariants), JSON.stringify(page.relatedTopics), JSON.stringify(page.sourceIds),
      page.platform ?? null, page.shopId ?? null, page.category ?? null, page.createdAt, page.updatedAt
    ]);
  }

  async saveCards(cards: KnowledgeCard[], embeddings: number[][]): Promise<void> {
    for (const [index, card] of cards.entries()) {
      const vector = `[${(embeddings[index] ?? []).join(',')}]`;
      await this.pool.query(`INSERT INTO rag_knowledge_cards
        (id,kb_id,wiki_page_id,title,content,answer,question_variants,keywords,tags,platform,shop_id,shop_name,category,
         related_card_ids,source_type,source_id,source_name,priority,enabled,embedding,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20::vector,$21,$22)
        ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,answer=EXCLUDED.answer,
        question_variants=EXCLUDED.question_variants,keywords=EXCLUDED.keywords,tags=EXCLUDED.tags,platform=EXCLUDED.platform,
        shop_id=EXCLUDED.shop_id,category=EXCLUDED.category,priority=EXCLUDED.priority,enabled=EXCLUDED.enabled,
        embedding=EXCLUDED.embedding,updated_at=EXCLUDED.updated_at`, [
        card.id, card.kbId, card.wikiPageId ?? null, card.title, card.content, card.answer ?? null,
        JSON.stringify(card.questionVariants), JSON.stringify(card.keywords), JSON.stringify(card.tags), card.platform ?? null,
        card.shopId ?? null, card.shopName ?? null, card.category, JSON.stringify(card.relatedCardIds), card.sourceType,
        card.sourceId ?? null, card.sourceName ?? null, card.priority, card.enabled, vector, card.createdAt, card.updatedAt
      ]);
    }
  }

  async listCards(filters: { platform?: string; shopId?: string; category?: string; limit?: number } = {}): Promise<KnowledgeCard[]> {
    const result = await this.pool.query(`SELECT * FROM rag_knowledge_cards
      WHERE enabled=TRUE
        AND ($1::text IS NULL OR platform IS NULL OR platform='all' OR platform=$1)
        AND ($2::text IS NULL OR shop_id IS NULL OR shop_id=$2)
        AND ($3::text IS NULL OR category=$3 OR category='other')
      ORDER BY priority DESC, updated_at DESC LIMIT $4`, [filters.platform ?? null, filters.shopId ?? null, filters.category ?? null, filters.limit ?? 500]);
    return result.rows.map(mapCard);
  }

  async vectorSearch(embedding: number[], filters: { platform?: string; shopId?: string; category?: string; limit: number }) {
    const vector = `[${embedding.join(',')}]`;
    const result = await this.pool.query(`SELECT *, 1 - (embedding <=> $1::vector) AS vector_score
      FROM rag_knowledge_cards WHERE enabled=TRUE AND embedding IS NOT NULL
        AND ($2::text IS NULL OR platform IS NULL OR platform='all' OR platform=$2)
        AND ($3::text IS NULL OR shop_id IS NULL OR shop_id=$3)
        AND ($4::text IS NULL OR category=$4 OR category='other')
      ORDER BY embedding <=> $1::vector LIMIT $5`, [vector, filters.platform ?? null, filters.shopId ?? null, filters.category ?? null, filters.limit]);
    return result.rows.map((row) => ({ card: mapCard(row), score: Number(row.vector_score ?? 0) }));
  }

  async saveEdges(edges: KnowledgeGraphEdge[]): Promise<void> {
    for (const edge of edges) {
      await this.pool.query(`INSERT INTO rag_knowledge_graph_edges (id,from_id,to_id,relation)
        VALUES ($1,$2,$3,$4) ON CONFLICT (from_id,to_id,relation) DO NOTHING`, [edge.id, edge.fromId, edge.toId, edge.relation]);
    }
  }

  async relatedCardIds(cardIds: string[], limit: number): Promise<string[]> {
    if (cardIds.length === 0)
      return [];
    const result = await this.pool.query(`SELECT DISTINCT to_id FROM rag_knowledge_graph_edges
      WHERE from_id=ANY($1::text[]) LIMIT $2`, [cardIds, limit]);
    return result.rows.map((row) => row.to_id);
  }

  async recordGap(gap: Omit<KnowledgeGap, 'id' | 'count' | 'createdAt' | 'updatedAt'>): Promise<void> {
    const existed = await this.pool.query(`SELECT id FROM rag_knowledge_gaps WHERE query=$1
      AND platform IS NOT DISTINCT FROM $2 AND shop_id IS NOT DISTINCT FROM $3 LIMIT 1`, [gap.query, gap.platform ?? null, gap.shopId ?? null]);
    if (existed.rowCount) {
      await this.pool.query('UPDATE rag_knowledge_gaps SET count=count+1,updated_at=NOW() WHERE id=$1', [existed.rows[0].id]);
      return;
    }
    await this.pool.query(`INSERT INTO rag_knowledge_gaps
      (id,query,category,reason,suggested_card_title,suggested_question_variants,platform,shop_id)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [`gap_${nanoid()}`, gap.query, gap.category, gap.reason,
      gap.suggestedCardTitle, JSON.stringify(gap.suggestedQuestionVariants), gap.platform ?? null, gap.shopId ?? null]);
  }
}
