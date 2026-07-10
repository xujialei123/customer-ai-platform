// @ts-nocheck
/**
 * @file apps/api/src/utils/chunk-text.ts
 * @module API Service 与 Worker
 * @description 旧知识文本按段落/长度切片。
 * @see 联动关注：不要用于替代 GBrain 知识卡片。
 */
// 中文知识库切分函数。
// 这里先用简单字符窗口切分，后续可以升级成按标题、段落、Markdown 层级切分。
export function chunkText(text, options = {}) {
    const chunkSize = options.chunkSize ?? 700;
    const overlap = options.overlap ?? 100;
    const clean = text.replace(/\r\n/g, '\n').trim();
    if (!clean)
        return [];
    const chunks = [];
    let start = 0;
    while (start < clean.length) {
        const end = Math.min(start + chunkSize, clean.length);
        const chunk = clean.slice(start, end).trim();
        if (chunk)
            chunks.push(chunk);
        if (end >= clean.length)
            break;
        start = Math.max(0, end - overlap);
    }
    return chunks;
}
