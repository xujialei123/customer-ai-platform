// @ts-nocheck
/**
 * @file services/rag-service/src/parsers/file-parser.ts
 * @module RAG Service 兼容层
 * @description TXT/MD/CSV/PDF/DOCX/XLSX 文件解析。
 * @see 联动关注：扫描 PDF 仍需 OCR Adapter。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';
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
        const parser = new PDFParse({ data: await readFile(filePath) });
        try {
            const result = await parser.getText();
            if (!result.text.trim())
                throw new Error('PDF 未提取到文本；扫描件需要先经过 OCR Adapter 处理');
            return result.pages.map((page) => ({ content: page.text, page: page.num, metadata: { sourceType: 'pdf' } }));
        }
        finally {
            await parser.destroy();
        }
    }
    if (fileType === 'docx') {
        const result = await mammoth.extractRawText({ path: filePath });
        return [{ content: result.value, page: 1, metadata: { sourceType: 'docx', warnings: result.messages.map((item) => item.message) } }];
    }
    if (fileType === 'xlsx') {
        const workbook = XLSX.read(await readFile(filePath), { type: 'buffer' });
        return workbook.SheetNames.map((sheetName, index) => ({
            content: XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { blankrows: false }),
            page: index + 1,
            metadata: { sourceType: 'xlsx', sheetName }
        })).filter((part) => part.content.trim());
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
