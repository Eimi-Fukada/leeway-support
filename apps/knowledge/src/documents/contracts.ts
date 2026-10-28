import type { ProcessingSummary } from "./processing.ts";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_LIBRARY_DOCUMENTS = 200;
// 上传格式由受信任的服务端解析器注册表决定，下游不枚举新格式。
export type DocumentKind = "pdf" | "docx" | "text" | "markdown" | (string & {});
export interface StoredDocument {
  id: string; name: string; kind: DocumentKind; size: number; createdAt: string;
  status: "stored";
  processing: ProcessingSummary;
}
export interface TextPreview { text: string; truncated: boolean }
