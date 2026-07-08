// @ts-nocheck
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export function getFileType(fileName) {
    return fileName.split('.').pop()?.toLowerCase() ?? '';
}
export async function sha256File(filePath) {
    const buffer = await readFile(filePath);
    return createHash('sha256').update(buffer).digest('hex');
}
export async function parseKnowledgeFile(filePath, fileName) {
    const fileType = getFileType(fileName);
    if (fileType === 'txt' || fileType === 'md') {
        const content = await readFile(filePath, 'utf-8');
        return [{ content, page: 1, metadata: { sourceType: fileType } }];
    }
    if (fileType === 'csv') {
        return parseCsv(await readFile(filePath, 'utf-8'));
    }
    if (fileType === 'pdf') {
        throw new Error('当前 PDF 解析依赖未启用；如果是扫描件还需要 OCR。请先用 txt/md 验证流程。');
    }
    if (fileType === 'docx') {
        throw new Error('当前 DOCX 解析依赖未启用。请安装 mammoth 后接入解析器，或先上传 md/txt。');
    }
    if (fileType === 'xlsx') {
        throw new Error('当前 XLSX 解析依赖未启用。请安装 xlsx 后接入解析器，或先另存为 csv。');
    }
    throw new Error(`不支持的文件类型：${fileType}`);
}
function parseCsv(content) {
    const lines = content.replace(/\r\n/g, '\n').split('\n').filter((line) => line.trim());
    const header = splitCsvLine(lines[0] ?? '');
    return lines.slice(1).map((line, index) => {
        const values = splitCsvLine(line);
        const rowText = header.map((key, colIndex) => `${key || `列${colIndex + 1}`}=${values[colIndex] ?? ''}`).join('，');
        return {
            content: `第${index + 2}行：${rowText}`,
            page: 1,
            metadata: { sourceType: 'csv', rowIndex: index + 2 }
        };
    });
}
function splitCsvLine(line) {
    const result = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
            quoted = !quoted;
            continue;
        }
        if (char === ',' && !quoted) {
            result.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    result.push(current.trim());
    return result;
}
