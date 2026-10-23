import { randomUUID } from "node:crypto";
import type { MemoryRecord, MemoryRepository, MemoryWrite, MemoryResult } from "../../src/memory/service.ts";

// Agent 流程测试用存储替身；事务/并发/幂等以真实 PostgreSQL 测试为准。
export class TestMemoryRepository implements MemoryRepository {
  rows = new Map<string, MemoryRecord[]>();
  writes: MemoryWrite[] = [];
  async list(scope: string) { return (this.rows.get(scope) ?? []).filter((row) => !row.deleted); }
  async mutate(write: MemoryWrite): Promise<MemoryResult> {
    this.writes.push(write);
    const rows = this.rows.get(write.scope) ?? [];
    const existing = rows.find((row) => row.id === write.change.id);
    if (write.change.action === "save") {
      const record: MemoryRecord = { id: randomUUID(), version: 1, content: write.change.content!, deleted: false,
        source: write.source, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      rows.push(record); this.rows.set(write.scope, rows);
      return { status: "saved", id: record.id, version: 1 };
    }
    if (!existing) return { status: "rejected", code: "NOT_FOUND" };
    if (existing.version !== write.change.expectedVersion) return { status: "rejected", code: "VERSION_CONFLICT" };
    existing.version++;
    existing.content = write.change.content ?? "";
    existing.deleted = write.change.action === "forget";
    return { status: existing.deleted ? "forgotten" : "updated", id: existing.id, version: existing.version };
  }
}
