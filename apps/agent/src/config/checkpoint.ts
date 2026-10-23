import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createDatabasePool } from "./database.ts";

export async function createCheckpointer(connectionString?: string): Promise<PostgresSaver> {
  const pool = createDatabasePool(connectionString);
  const saver = new PostgresSaver(pool, undefined, { schema: "public" });
  try {
    // 官方初始化/迁移，表统一放在产品库 public 中，不创建其他数据库或 schema。
    await saver.setup();
    return saver;
  } catch (cause: unknown) {
    await saver.end();
    throw new Error("数据库初始化失败：请检查 PostgreSQL、DATABASE_URL 和建表权限。", { cause });
  }
}
