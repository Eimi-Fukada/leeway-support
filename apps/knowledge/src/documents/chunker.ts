import { createHash } from "node:crypto";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { ParsedDocument } from "./parsers/types.ts";

export const CHUNK_CONFIG = { size: 1000, overlap: 120, version: "recursive-1.0.2-v1" } as const;
export interface DocumentChunk { id: string; ordinal: number; text: string; headingPath: string[]; section: number; start: number; end: number; hash: string }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
class UnicodeTextSplitter extends RecursiveCharacterTextSplitter {
  // 复用成熟递归切分/合并算法，只修正最终按字符兜底时的 UTF-16 代理对边界。
  protected splitOnSeparator(text: string, separator: string): string[] {
    return separator === "" ? Array.from(text) : super.splitOnSeparator(text, separator);
  }
}
function chunkId(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export async function chunkDocument(documentId: string, parsed: ParsedDocument): Promise<DocumentChunk[]> {
  const splitter = new UnicodeTextSplitter({ chunkSize: CHUNK_CONFIG.size, chunkOverlap: CHUNK_CONFIG.overlap, keepSeparator: true,
    separators: ["\n\n", "\n", "。", "！", "？", ". ", "；", "; ", "，", ", ", " ", ""] });
  const chunks: DocumentChunk[] = [];
  const fingerprint = hash(JSON.stringify({ text: parsed.text, parser: [parsed.parserId, parsed.parserVersion], config: CHUNK_CONFIG }));
  let sectionEnd = 0;
  for (const [sectionIndex, section] of parsed.sections.entries()) {
    if (!Number.isInteger(section.start) || !Number.isInteger(section.end) || section.start<sectionEnd || section.end<=section.start || section.end>parsed.text.length
      || parsed.text.slice(sectionEnd,section.start).trim()) throw new Error("Invalid parsed section ranges");
    sectionEnd = section.end;
    const source = parsed.text.slice(section.start, section.end);
    let previousStart = -1; let previousEnd = 0;
    for (const text of await splitter.splitText(source)) {
      const start = source.indexOf(text, Math.max(previousStart + 1, previousEnd - CHUNK_CONFIG.overlap));
      if (start < 0) throw new Error("Chunk source position mismatch");
      const end = start + text.length;
      previousStart = start; previousEnd = end;
      chunks.push({ id: chunkId(`${documentId}:${fingerprint}:${chunks.length}:${section.start + start}`), ordinal: chunks.length,
        text, headingPath: section.headingPath, section: sectionIndex, start: section.start + start, end: section.start + end, hash: hash(text) });
      if (chunks.length > 5000) throw new Error("Too many chunks");
    }
  }
  if (parsed.text.slice(sectionEnd).trim()) throw new Error("Parsed sections omit source text");
  if (!chunks.length) throw new Error("No chunks");
  return chunks;
}
