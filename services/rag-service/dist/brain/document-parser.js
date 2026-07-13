/**
 * @file services/rag-service/src/brain/document-parser.ts
 * @module GBrain 与 Hybrid RAG
 * @description 将原始文件解析为统一 ParsedDocument 结构。
 * @see 联动关注：parsers/file-parser.ts。
 */
import { nanoid } from 'nanoid';
import { getFileType, parseKnowledgeFile } from '../parsers/file-parser.js';
export async function parseDocument(filePath, fileName) {
    const parts = await parseKnowledgeFile(filePath, fileName);
    return {
        id: `doc_${nanoid()}`,
        name: fileName,
        type: getFileType(fileName),
        text: parts.map((part) => part.content).join('\n\n'),
        metadata: { pages: parts.length, parts: parts.map((part) => ({ page: part.page, metadata: part.metadata })) }
    };
}
