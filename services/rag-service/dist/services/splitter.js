// @ts-nocheck
import { nanoid } from 'nanoid';
function splitLongParagraph(text, chunkSize, overlap) {
    // 超长段落使用重叠窗口，避免关键句恰好位于切片边界而丢失上下文。
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        const part = text.slice(start, end).trim();
        if (part)
            chunks.push(part);
        if (end >= text.length)
            break;
        start = Math.max(end - overlap, start + 1);
    }
    return chunks;
}
export function splitDocuments(input) {
    // 切片目标是保持单一语义主题；Markdown 标题优先于固定字符数，FAQ 因而能独立召回。
    const chunkSize = input.options?.chunkSize ?? 800;
    const overlap = input.options?.overlap ?? 120;
    const chunks = [];
    for (const part of input.parts) {
        const paragraphs = part.content
            .replace(/\r\n/g, '\n')
            .split(/\n{2,}|(?=^#{1,6}\s)/m)
            .map((item) => item.trim())
            .filter(Boolean);
        let buffer = '';
        for (const paragraph of paragraphs) {
            const isMarkdownHeading = /^#{1,6}\s/.test(paragraph);
            // Markdown 标题代表新的语义主题；遇到标题先结束上一块，避免多个 FAQ 被拼进同一个大向量。
            if (isMarkdownHeading && buffer.trim()) {
                chunks.push(createChunk(input, part, buffer, chunks.length));
                buffer = '';
            }
            if (paragraph.length > chunkSize) {
                if (buffer.trim()) {
                    chunks.push(createChunk(input, part, buffer, chunks.length));
                    buffer = '';
                }
                for (const longPart of splitLongParagraph(paragraph, chunkSize, overlap)) {
                    chunks.push(createChunk(input, part, longPart, chunks.length));
                }
                continue;
            }
            const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
            if (candidate.length > chunkSize && buffer.trim()) {
                chunks.push(createChunk(input, part, buffer, chunks.length));
                buffer = paragraph;
            }
            else {
                buffer = candidate;
            }
        }
        if (buffer.trim()) {
            chunks.push(createChunk(input, part, buffer, chunks.length));
        }
    }
    return chunks;
}
function createChunk(input, part, content, chunkIndex) {
    // chunk ID 每次 ingest 重新生成，写入前会按 fileId 删除旧版本，避免新旧向量混检。
    return {
        id: `chunk_${nanoid()}`,
        kbId: input.kbId,
        fileId: input.fileId,
        fileName: input.fileName,
        content: content.trim(),
        page: part.page,
        chunkIndex,
        metadata: part.metadata,
        createdAt: new Date().toISOString()
    };
}
