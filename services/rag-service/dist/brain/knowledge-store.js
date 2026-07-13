/**
 * @file services/rag-service/src/brain/knowledge-store.ts
 * @module GBrain 与 Hybrid RAG
 * @description Wiki/Card/Graph/Gap 的 PostgreSQL CRUD。
 * @see 联动关注：init-db.sql 和 kb-admin 后台。
 */
import pg from 'pg';
import { nanoid } from 'nanoid';
import { env } from '../config/env.js';
function arrayValue(value) {
    return Array.isArray(value) ? value.map(String) : [];
}
function mapCard(row) {
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
    async saveWikiPage(page) {
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
    async deleteCompiledSource(fileId) {
        // 重复编译同一文件前清理旧卡片和 Wiki，避免管理页与检索结果成倍增长。
        await this.pool.query('DELETE FROM rag_knowledge_cards WHERE source_id=$1', [fileId]);
        await this.pool.query(`DELETE FROM rag_wiki_pages WHERE source_ids @> $1::jsonb`, [JSON.stringify([fileId])]);
    }
    async saveCards(cards, embeddings) {
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
    async listCards(filters = {}) {
        const result = await this.pool.query(`SELECT * FROM rag_knowledge_cards
      WHERE enabled=TRUE
        AND ($1::text IS NULL OR platform IS NULL OR platform='all' OR platform=$1)
        AND ($2::text IS NULL OR shop_id IS NULL OR shop_id=$2)
        AND ($3::text IS NULL OR category=$3 OR category='other')
      ORDER BY priority DESC, updated_at DESC LIMIT $4`, [filters.platform ?? null, filters.shopId ?? null, filters.category ?? null, filters.limit ?? 500]);
        return result.rows.map(mapCard);
    }
    async getCard(id) {
        const result = await this.pool.query('SELECT * FROM rag_knowledge_cards WHERE id=$1', [id]);
        return result.rows[0] ? mapCard(result.rows[0]) : null;
    }
    async listWikiPages(kbId) {
        const result = await this.pool.query(`SELECT id,kb_id,title,summary,platform,shop_id,category,created_at,updated_at
      FROM rag_wiki_pages WHERE ($1::text IS NULL OR kb_id=$1) ORDER BY updated_at DESC LIMIT 200`, [kbId ?? null]);
        return result.rows;
    }
    async listEdges(limit = 300) {
        const result = await this.pool.query('SELECT id,from_id,to_id,relation,created_at FROM rag_knowledge_graph_edges ORDER BY created_at DESC LIMIT $1', [limit]);
        return result.rows;
    }
    async listGaps(limit = 200) {
        const result = await this.pool.query('SELECT * FROM rag_knowledge_gaps ORDER BY count DESC,updated_at DESC LIMIT $1', [limit]);
        return result.rows;
    }
    async updateCard(id, patch) {
        const current = await this.getCard(id);
        if (!current)
            return null;
        const next = { ...current, ...patch, id: current.id, kbId: current.kbId, updatedAt: new Date().toISOString() };
        await this.pool.query(`UPDATE rag_knowledge_cards SET title=$2,content=$3,answer=$4,question_variants=$5::jsonb,
      keywords=$6::jsonb,tags=$7::jsonb,platform=$8,shop_id=$9,shop_name=$10,category=$11,
      related_card_ids=$12::jsonb,priority=$13,enabled=$14,updated_at=$15 WHERE id=$1`, [id, next.title, next.content,
            next.answer ?? null, JSON.stringify(next.questionVariants), JSON.stringify(next.keywords), JSON.stringify(next.tags),
            next.platform ?? null, next.shopId ?? null, next.shopName ?? null, next.category, JSON.stringify(next.relatedCardIds),
            next.priority, next.enabled, next.updatedAt]);
        return this.getCard(id);
    }
    async vectorSearch(embedding, filters) {
        const vector = `[${embedding.join(',')}]`;
        const result = await this.pool.query(`SELECT *, 1 - (embedding <=> $1::vector) AS vector_score
      FROM rag_knowledge_cards WHERE enabled=TRUE AND embedding IS NOT NULL
        AND ($2::text IS NULL OR platform IS NULL OR platform='all' OR platform=$2)
        AND ($3::text IS NULL OR shop_id IS NULL OR shop_id=$3)
        AND ($4::text IS NULL OR category=$4 OR category='other')
      ORDER BY embedding <=> $1::vector LIMIT $5`, [vector, filters.platform ?? null, filters.shopId ?? null, filters.category ?? null, filters.limit]);
        return result.rows.map((row) => ({ card: mapCard(row), score: Number(row.vector_score ?? 0) }));
    }
    async saveEdges(edges) {
        for (const edge of edges) {
            await this.pool.query(`INSERT INTO rag_knowledge_graph_edges (id,from_id,to_id,relation)
        VALUES ($1,$2,$3,$4) ON CONFLICT (from_id,to_id,relation) DO NOTHING`, [edge.id, edge.fromId, edge.toId, edge.relation]);
        }
    }
    async relatedCardIds(cardIds, limit) {
        if (cardIds.length === 0)
            return [];
        const result = await this.pool.query(`SELECT DISTINCT to_id FROM rag_knowledge_graph_edges
      WHERE from_id=ANY($1::text[]) LIMIT $2`, [cardIds, limit]);
        return result.rows.map((row) => row.to_id);
    }
    async recordGap(gap) {
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
