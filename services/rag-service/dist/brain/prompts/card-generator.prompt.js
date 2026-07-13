/**
 * @file services/rag-service/src/brain/prompts/card-generator.prompt.ts
 * @module GBrain 与 Hybrid RAG
 * @description 知识卡片拆分规则的 LLM Prompt。
 * @see 联动关注：KnowledgeCardGenerator 调用。
 */
export const cardGeneratorRules = [
    '一个 FAQ 生成一张卡片',
    '退款、预约、套餐、停车、地址、营业时间分别形成独立卡片',
    '卡片必须保留可直接回答客户的明确事实，不得补充原资料没有的信息'
].join('；');
