import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { MemoryRecord, MemoryRepository, MemoryResult, MemoryWrite } from "./service.ts";
import { readSupportSchema } from "../config/schema.ts";

type MemoryRow = Omit<MemoryRecord, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(private readonly pool: pg.Pool) {}
  async setup(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(461992303)");
      await client.query(await readSupportSchema("001_long_term_memory.sql"));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async list(scope: string): Promise<MemoryRecord[]> {
    const result = await this.pool.query<MemoryRow>(`SELECT id, version, content, deleted, source,
      created_at AS "createdAt", updated_at AS "updatedAt" FROM public.support_memories
      WHERE scope=$1 AND NOT deleted ORDER BY updated_at DESC, id LIMIT 50`, [scope]);
    return result.rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
  }

  async mutate(write: MemoryWrite): Promise<MemoryResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 同一归属的变更串行化，跨进程也保护容量、去重、版本校验与操作幂等。
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        BigInt.asIntN(64, BigInt(`0x${createHash("sha256").update(write.scope).digest("hex").slice(0, 16)}`)).toString(),
      ]);
      const previous = await client.query("SELECT payload_hash, result FROM public.support_memory_operations WHERE scope=$1 AND operation_id=$2", [write.scope, write.operationId]);
      if (previous.rows[0]) {
        const result: MemoryResult = previous.rows[0].payload_hash === write.payloadHash ? previous.rows[0].result : { status: "rejected", code: "OPERATION_CONFLICT" };
        await client.query("COMMIT");
        return result;
      }
      let result: MemoryResult;
      const change = write.change;
      if (change.action === "save") {
        const duplicate = await client.query("SELECT id, version FROM public.support_memories WHERE scope=$1 AND content=$2 AND NOT deleted LIMIT 1", [write.scope, change.content]);
        if (duplicate.rows[0]) result = { status: "saved", ...duplicate.rows[0] };
        else {
          const count = await client.query("SELECT count(*)::int AS count, coalesce(sum(length(content)),0)::int AS chars FROM public.support_memories WHERE scope=$1 AND NOT deleted", [write.scope]);
          if (count.rows[0].count >= 50 || count.rows[0].chars + change.content!.length > 8000) result = { status: "rejected", code: "CAPACITY" };
          else {
            const id = randomUUID();
            await client.query("INSERT INTO public.support_memories(scope,id,version,content,source) VALUES($1,$2,1,$3,$4)", [write.scope, id, change.content, write.source]);
            result = { status: "saved", id, version: 1 };
          }
        }
      } else {
        const found = await client.query("SELECT version, deleted, content FROM public.support_memories WHERE scope=$1 AND id=$2", [write.scope, change.id]);
        if (!found.rows[0] || found.rows[0].deleted) result = { status: "rejected", code: "NOT_FOUND" };
        else if (found.rows[0].version !== change.expectedVersion) result = { status: "rejected", code: "VERSION_CONFLICT" };
        else {
          const forgotten = change.action === "forget";
          const count = await client.query("SELECT coalesce(sum(length(content)),0)::int AS chars FROM public.support_memories WHERE scope=$1 AND NOT deleted", [write.scope]);
          if (!forgotten && count.rows[0].chars - found.rows[0].content.length + change.content!.length > 8000) {
            result = { status: "rejected", code: "CAPACITY" };
          } else {
            await client.query(`UPDATE public.support_memories SET version=version+1, content=$3, deleted=$4,
              source=$5, updated_at=now() WHERE scope=$1 AND id=$2`, [write.scope, change.id, forgotten ? "" : change.content, forgotten, write.source]);
            result = { status: forgotten ? "forgotten" : "updated", id: change.id!, version: found.rows[0].version + 1 };
          }
        }
      }
      await client.query("INSERT INTO public.support_memory_operations(scope,operation_id,payload_hash,result) VALUES($1,$2,$3,$4)", [write.scope, write.operationId, write.payloadHash, result]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}
