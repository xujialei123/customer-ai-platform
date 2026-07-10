/**
 * @file services/rag-service/src/brain/knowledge-card-generator.ts
 * @module GBrain 与 Hybrid RAG
 * @description 从 FAQ、章节、字段和表格生成可检索知识卡片。
 * @see 联动关注：分类标签与 Embedding 写入。
 */
import { nanoid } from 'nanoid';
import { classifyIntent } from '../rag/intent-classifier.js';
import { extractKeywords } from '../rag/keyword.js';
import { brainConfig } from './config.js';
import type { KnowledgeCard, WikiPage } from './types.js';

export class KnowledgeCardGenerator {
  generate(page: WikiPage, source: { id?: string; name?: string; type?: string } = {}): KnowledgeCard[] {
    const now = new Date().toISOString();
    const sections = [...page.content.matchAll(/^#{1,6}\s+(.+)\r?\n([\s\S]*?)(?=^#{1,6}\s+|(?![\s\S]))/gm)]
      .map((match) => ({ question: match[1].trim(), answer: match[2].trim() }))
      .filter((item) => item.answer.length >= 8 && item.answer.length <= 3000);
    // FAQ 与章节规则合并，避免只生成问答卡而漏掉停车、预约、退款等正文规则。
    const fields = [...page.content.matchAll(/^\s*[-*]\s+([^：:\n]{2,30})[：:]\s*(.+)$/gm)]
      .map((match) => ({ question: match[1].trim(), answer: `${match[1].trim()}：${match[2].trim()}` }));
    const tableRows = [...page.content.matchAll(/^\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)\s*\|/gm)]
      .filter((match) => !/---|服务品类|常规参考价/.test(match[0]))
      .map((match) => ({ question: `${match[1].trim()}价格和时效`, answer: `${match[1].trim()}：${match[2].trim()}，普通时效 ${match[3].trim()}` }));
    const items = [...new Map([...page.faq, ...sections, ...fields, ...tableRows].map((item) => [item.question, item])).values()];
    const cardItems = items.length ? items : [{ question: page.title, answer: page.content }];
    return cardItems.slice(0, brainConfig.maxCardsPerWiki).map((faq) => {
      const titleIntent = classifyIntent(faq.question);
      const intent = titleIntent.category === 'other' ? classifyIntent(`${faq.question} ${faq.answer}`) : titleIntent;
      const category = intent.category === 'other' ? 'faq' : intent.category;
      return {
        id: `card_${nanoid()}`,
        kbId: page.kbId,
        wikiPageId: page.id,
        title: faq.question,
        content: faq.answer,
        answer: faq.answer,
        questionVariants: [...new Set([faq.question, ...page.questionVariants.filter((item) => classifyIntent(item).category === category)])].slice(0, 12),
        keywords: extractKeywords(`${faq.question} ${faq.answer} ${page.keywords.join(' ')}`).slice(0, 30),
        tags: [category, ...page.relatedTopics].slice(0, 12),
        platform: page.platform ?? 'all',
        shopId: page.shopId,
        category,
        relatedCardIds: [],
        sourceType: source.type === 'pdf' ? 'pdf' : source.type === 'docx' ? 'word' : source.type === 'xlsx' ? 'excel' : source.type === 'md' ? 'markdown' : 'wiki',
        sourceId: source.id,
        sourceName: source.name,
        priority: brainConfig.defaultPriority,
        enabled: true,
        createdAt: now,
        updatedAt: now
      };
    });
  }
}
