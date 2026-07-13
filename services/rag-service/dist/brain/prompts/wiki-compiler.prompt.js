/**
 * @file services/rag-service/src/brain/prompts/wiki-compiler.prompt.ts
 * @module GBrain 与 Hybrid RAG
 * @description Wiki 结构化 JSON 输出的 LLM Prompt。
 * @see 联动关注：WikiCompiler 调用。
 */
export function wikiCompilerPrompt(documentName, text) {
    return `你是企业知识整理助手。请根据原始资料整理结构化 Wiki，不要简单复制原文。
需要提炼标题、总结、关键规则、FAQ、用户可能问法、关键词和关联知识。
只输出 JSON：{"title":"","summary":"","content":"","faq":[{"question":"","answer":""}],"keywords":[],"questionVariants":[],"relatedTopics":[],"category":"other"}
文件名：${documentName}
原始资料：
${text}`;
}
