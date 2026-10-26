import type { ConversationBackend, RequestRecord } from "../../src/conversations/service.ts";
import type { ConversationSnapshot } from "../../src/conversations/contracts.ts";
import type { SupportRunResult } from "../../src/interactions/service.ts";

// SQL 的事务、序列与并发以真实 PostgreSQL 测试为准；本替身只承接主链路边界。
export class TestConversationBackend implements ConversationBackend {
  records = new Map<string, RequestRecord>();
  messages = new Map<string, ConversationSnapshot["messages"]>();
  completeness = new Map<string, boolean>();
  key(scope: string, thread: string) { return `${scope}:${thread}`; }
  async find(scope: string, thread: string, requestId: string) { return this.records.get(`${this.key(scope, thread)}:${requestId}`); }
  async start(scope: string, thread: string, requestId: string, runId: string, payloadHash: string, content: string, historyComplete = true, kind: RequestRecord["kind"] = "legacy") {
    const key = this.key(scope, thread);
    this.records.set(`${key}:${requestId}`, { kind, requestId, runId, payloadHash, status: "running", result: null, updatedAt: new Date().toISOString() });
    this.messages.set(key, [...this.messages.get(key) ?? [], { id: requestId, role: "user", content }]);
    this.completeness.set(key, historyComplete);
  }
  async finish(scope: string, thread: string, requestId: string, result: SupportRunResult) {
    const record = (await this.find(scope, thread, requestId))!;
    record.status = result.status; record.result = structuredClone(result);
    const key = this.key(scope, thread);
    const messages = this.messages.get(key)!;
    if (result.status === "completed" && !messages.some((message) => message.id === `assistant-${requestId}`)) {
      messages.push({ id: `assistant-${requestId}`, role: "assistant", content: result.answer });
    }
  }
  async uncertain(scope: string, thread: string, requestId: string, status: "failed" | "unknown") {
    const record = (await this.find(scope, thread, requestId))!;
    if (["running", "unknown"].includes(record.status)) record.status = status;
  }
  async history(scope: string, thread: string) {
    const key = this.key(scope, thread);
    return { messages: structuredClone(this.messages.get(key) ?? []), historyComplete: this.completeness.get(key) ?? true,
      requests: [...this.records.entries()].filter(([id]) => id.startsWith(`${key}:`)).map(([, record]) => {
        const { requestId, runId, status, updatedAt } = record; return { requestId, runId, status, updatedAt };
      }) };
  }
}
