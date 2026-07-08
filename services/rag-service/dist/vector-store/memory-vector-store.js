// @ts-nocheck
import { repository } from '../services/store.js';
import { cosineSimilarity } from './vector-store.js';
export class MemoryVectorStore {
    async upsertChunks(chunks) {
        for (const chunk of chunks) {
            repository.chunks.set(chunk.id, chunk);
        }
    }
    async search(input) {
        return repository.getChunksByKbIds(input.kbIds)
            .map((chunk) => ({
            chunk,
            score: Math.max(cosineSimilarity(input.queryEmbedding, chunk.embedding ?? []), lexicalScore(input.queryText ?? '', chunk.content))
        }))
            .sort((left, right) => right.score - left.score)
            .slice(0, input.topK)
            .map(({ chunk, score }) => ({
            chunkId: chunk.id,
            content: chunk.content,
            score,
            fileId: chunk.fileId,
            fileName: chunk.fileName ?? repository.files.get(chunk.fileId)?.fileName ?? '',
            page: chunk.page,
            metadata: chunk.metadata
        }));
    }
    async deleteByFileId(fileId) {
        for (const chunk of [...repository.chunks.values()]) {
            if (chunk.fileId === fileId)
                repository.chunks.delete(chunk.id);
        }
    }
}
function lexicalScore(queryText, content) {
    // mock embedding 没有真实语义能力，本地开发时用中文字符重叠兜底，避免明明有关键词却全部低分转人工。
    // 无重叠时仍返回 0，保留“低相似度转人工”的安全行为。
    const queryChars = [...new Set(queryText.replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, '').split(''))];
    if (queryChars.length === 0)
        return 0;
    const matched = queryChars.filter((char) => content.includes(char)).length;
    const ratio = matched / queryChars.length;
    return ratio >= 0.4 ? Math.min(0.95, 0.7 + ratio * 0.25) : 0;
}
