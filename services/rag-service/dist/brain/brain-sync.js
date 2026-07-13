/**
 * @file services/rag-service/src/brain/brain-sync.ts
 * @module GBrain 与 Hybrid RAG
 * @description 串联解析→Wiki→卡片→向量→Graph 的编译主流程。
 * @see 联动关注：编译 API 核心编排。
 */
import { createEmbeddingProvider } from '../providers/embedding.js';
import { parseDocument } from './document-parser.js';
import { GraphBuilder } from './graph-builder.js';
import { KnowledgeCardGenerator } from './knowledge-card-generator.js';
import { KnowledgeStore } from './knowledge-store.js';
import { WikiCompiler } from './wiki-compiler.js';
export class BrainSync {
    store;
    compiler;
    cardGenerator;
    graphBuilder;
    embeddingProvider;
    constructor(store = new KnowledgeStore(), compiler = new WikiCompiler(), cardGenerator = new KnowledgeCardGenerator(), graphBuilder = new GraphBuilder(), embeddingProvider = createEmbeddingProvider()) {
        this.store = store;
        this.compiler = compiler;
        this.cardGenerator = cardGenerator;
        this.graphBuilder = graphBuilder;
        this.embeddingProvider = embeddingProvider;
    }
    async compileFile(input) {
        const document = await parseDocument(input.filePath, input.fileName);
        const wikiPage = await this.compiler.compile({ document, kbId: input.kbId, platform: input.platform, shopId: input.shopId });
        wikiPage.sourceIds = [input.fileId];
        const cards = this.cardGenerator.generate(wikiPage, { id: input.fileId, name: input.fileName, type: document.type });
        const embeddingTexts = cards.map((card) => [card.title, ...card.questionVariants, card.answer ?? card.content, ...card.keywords].join('\n'));
        const embeddings = await this.embeddingProvider.embedTexts(embeddingTexts);
        const edges = this.graphBuilder.build(cards);
        // Wiki、卡片、向量和关系全部准备好后再依次写库，避免后台看到只有标题没有可检索向量的半成品。
        await this.store.deleteCompiledSource(input.fileId);
        await this.store.saveWikiPage(wikiPage);
        await this.store.saveCards(cards, embeddings);
        await this.store.saveEdges(edges);
        return { wikiPage, cards, edges };
    }
}
