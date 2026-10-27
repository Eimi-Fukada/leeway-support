export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_LIBRARY_DOCUMENTS = 200;
export const ACCEPT_DOCUMENTS = ".pdf,.docx,.txt,.md,.markdown";
export type DocumentKind = "pdf" | "docx" | "text" | "markdown";
export interface StoredDocument {
  id: string; name: string; kind: DocumentKind; size: number; createdAt: string;
  status: "stored";
}
export interface TextPreview { text: string; truncated: boolean }
