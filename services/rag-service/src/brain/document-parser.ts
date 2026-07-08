import { nanoid } from 'nanoid';
import { getFileType, parseKnowledgeFile } from '../parsers/file-parser.js';
import type { ParsedDocument } from './types.js';

export async function parseDocument(filePath: string, fileName: string): Promise<ParsedDocument> {
  const parts = await parseKnowledgeFile(filePath, fileName) as Array<{ content: string; page: number; metadata: Record<string, unknown> }>;
  return {
    id: `doc_${nanoid()}`,
    name: fileName,
    type: getFileType(fileName),
    text: parts.map((part) => part.content).join('\n\n'),
    metadata: { pages: parts.length, parts: parts.map((part) => ({ page: part.page, metadata: part.metadata })) }
  };
}
