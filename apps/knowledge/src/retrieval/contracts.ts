import { z } from "zod";

export const retrievalInput = z.object({ question: z.string().trim().min(1).max(4000) }).strict();
export interface Evidence {
  evidenceId: string; knowledgeBaseId: string; documentId: string; documentName: string;
  chunkId: string; sourceSha256: string; generationId: string; embeddingProfileId: string;
  headingPath: string[]; sectionIndex: number; startOffset: number; endOffset: number;
  text: string; contentSha256: string; score: number;
}
export interface RetrievalResult {
  retrievalId: string; status: "ok" | "no_match" | "no_ready_documents";
  evidence: Evidence[]; budgetLimited: boolean; scopeRevision: string;
}
