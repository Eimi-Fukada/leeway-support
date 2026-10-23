import { createDatabasePool } from "./database.ts";
import { PostgresMemoryRepository } from "../memory/postgres.ts";
import { MemoryService } from "../memory/service.ts";

export async function createMemory(connectionString?: string) {
  const pool = createDatabasePool(connectionString);
  try {
    const repository = new PostgresMemoryRepository(pool);
    await repository.setup();
    return { service: new MemoryService(repository), close: () => pool.end() };
  } catch (cause) {
    await pool.end();
    throw new Error("长期记忆初始化失败：请检查 PostgreSQL 和 public 建表权限。", { cause });
  }
}
