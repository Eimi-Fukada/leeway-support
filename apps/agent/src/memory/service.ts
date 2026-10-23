import { createHash } from "node:crypto";
import { memoryScope, validateSupportContext, type SupportContext } from "../support-context.ts";
import { redactPii } from "../agent/middleware/pii.ts";

export interface MemoryRecord {
  id: string;
  version: number;
  content: string;
  deleted: boolean;
  source: { threadId: string; messageId: string; quote: string };
  createdAt: string;
  updatedAt: string;
}
export type MemoryChange = { action: "save" | "update" | "forget"; id?: string; expectedVersion?: number; content?: string };
export interface MemoryWrite {
  scope: string;
  operationId: string;
  payloadHash: string;
  change: MemoryChange;
  source: MemoryRecord["source"];
}
export type MemoryResult = { status: "saved" | "updated" | "forgotten"; id: string; version: number } |
  { status: "rejected"; code: "NOT_FOUND" | "VERSION_CONFLICT" | "OPERATION_CONFLICT" | "CAPACITY" | "INVALID_CONTENT" | "INVALID_EVIDENCE" | "ANONYMOUS" };
export interface MemoryRepository {
  list(scope: string): Promise<MemoryRecord[]>;
  mutate(write: MemoryWrite): Promise<MemoryResult>;
}

export class MemoryService {
  constructor(private readonly repository: MemoryRepository) {}

  async list(context: SupportContext): Promise<MemoryRecord[]> {
    const valid = validateSupportContext(context);
    if (valid.subject.kind === "anonymous") return [];
    try { return await this.repository.list(memoryScope(valid)); }
    catch (cause) { throw new Error("长期记忆读取失败：本轮停止，请检查存储服务。", { cause }); }
  }

  async write(context: SupportContext, input: {
    change: MemoryChange; operationId: string; threadId: string; messageId: string;
    evidenceQuote: string; sourceText: string;
  }): Promise<MemoryResult> {
    const valid = validateSupportContext(context);
    if (valid.subject.kind === "anonymous") return { status: "rejected", code: "ANONYMOUS" };
    const quote = redactPii(input.evidenceQuote).trim();
    if (!quote || quote.length > 1500 || !redactPii(input.sourceText).includes(quote)) {
      return { status: "rejected", code: "INVALID_EVIDENCE" };
    }
    const change = { ...input.change };
    // 只是已知凭据形态的拒绝规则，不声称覆盖所有敏感内容。
    const credential = /(?:api[_ -]?key|password|密码|access[_ -]?token)\s*[:=：]\s*\S+|\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+\S+/i;
    if (credential.test(`${change.content ?? ""}\n${input.sourceText}`)) {
      return { status: "rejected", code: "INVALID_CONTENT" };
    }
    if (change.action !== "forget") {
      const content = redactPii(change.content ?? "").trim();
      if (!content || content.length > 1000 || !content.replace(/\[REDACTED_[A-Z_]+\]|[\s\p{P}]/gu, "")) {
        return { status: "rejected", code: "INVALID_CONTENT" };
      }
      change.content = content;
    }
    if (!input.operationId || input.operationId.length > 512 || !input.threadId || !input.messageId ||
      (change.action !== "save" && (!change.id || !/^[0-9a-f-]{36}$/i.test(change.id) || !Number.isSafeInteger(change.expectedVersion) || change.expectedVersion! < 1))) {
      return { status: "rejected", code: "INVALID_CONTENT" };
    }
    const source = { threadId: input.threadId, messageId: input.messageId, quote };
    const payloadHash = createHash("sha256").update(JSON.stringify({ change, source })).digest("hex");
    try { return await this.repository.mutate({ scope: memoryScope(valid), operationId: input.operationId, payloadHash, change, source }); }
    catch (cause) { throw new Error("长期记忆写入失败：保存结果未确认，不会自动重试。", { cause }); }
  }
}
