/**
 * @file services/rag-service/src/brain/wiki-compiler.ts
 * @module GBrain 与 Hybrid RAG
 * @description LLM 生成结构化 Wiki，失败时本地规则回退。
 * @see 联动关注：wiki-compiler.prompt.ts 和卡片生成。
 */
import { nanoid } from 'nanoid';
import { createLLMProvider } from '../providers/llm.js';
import { classifyIntent } from '../rag/intent-classifier.js';
import { extractKeywords } from '../rag/keyword.js';
import { brainConfig } from './config.js';
import { wikiCompilerPrompt } from './prompts/wiki-compiler.prompt.js';
import type { KnowledgePlatform, ParsedDocument, WikiPage } from './types.js';

function extractFaq(text: string): Array<{ question: string; answer: string }> {
  const matches = [...text.matchAll(/(?:^|\n)\s*(?:问[:：]|#{1,6}\s*问[:：]?)([^\n]+)\n+\s*(?:答[:：])?([^\n]+(?:\n(?!\s*(?:问[:：]|#{1,6}\s*问))[^\n]+)*)/g)];
  return matches.map((match) => ({ question: match[1].trim(), answer: match[2].trim() })).slice(0, brainConfig.maxCardsPerWiki);
}

export class WikiCompiler {
  provider = createLLMProvider();

  async compile(input: { document: ParsedDocument; kbId: string; platform?: KnowledgePlatform; shopId?: string }): Promise<WikiPage> {
    const now = new Date().toISOString();
    const fallbackFaq = extractFaq(input.document.text);
    let structured: Record<string, any> = {};
    try {
      const raw = await this.provider.chat({ platform: input.platform ?? 'all', prompt: wikiCompilerPrompt(input.document.name, input.document.text.slice(0, brainConfig.maxDocumentChars)) });
      structured = JSON.parse(raw.match(/\{[\s\S]*}/)?.[0] ?? raw);
    }
    catch (error) {
      // LLM Wiki 是整理增强层；模型不可用时保留确定性结构，原始知识仍可生成卡片并被检索。
      console.warn('[WikiCompiler] LLM 编译失败，使用本地结构化兜底：', error instanceof Error ? error.message : String(error));
    }
    const title = String(structured.title || input.document.name.replace(/\.[^.]+$/, ''));
    // 原文是事实源，LLM 整理结果只能作为摘要和结构元数据，不能覆盖原文导致规则丢失。
    const content = input.document.text;
    const intent = classifyIntent(`${title} ${content.slice(0, 500)}`);
    return {
      id: `wiki_${nanoid()}`,
      kbId: input.kbId,
      title,
      summary: String(structured.summary || content.slice(0, 240)),
      content,
      faq: [...new Map([...(Array.isArray(structured.faq) ? structured.faq : []), ...fallbackFaq]
        .filter((item) => item?.question && item?.answer)
        .map((item) => [String(item.question).trim(), { question: String(item.question).trim(), answer: String(item.answer).trim() }])).values()],
      keywords: Array.isArray(structured.keywords) ? structured.keywords.map(String) : extractKeywords(`${title} ${content}`).slice(0, 30),
      questionVariants: Array.isArray(structured.questionVariants) ? structured.questionVariants.map(String) : fallbackFaq.map((item) => item.question),
      relatedTopics: Array.isArray(structured.relatedTopics) ? structured.relatedTopics.map(String) : [],
      sourceIds: [input.document.id],
      platform: input.platform ?? 'all',
      shopId: input.shopId,
      category: structured.category || intent.category,
      createdAt: now,
      updatedAt: now
    };
  }
}
