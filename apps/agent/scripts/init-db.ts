import type pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createDatabasePool } from "../src/config/database.ts";
import { createCheckpointer } from "../src/config/checkpoint.ts";

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
try {
  pool = createDatabasePool();
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(461992306)");
  const files = (await readdir(new URL("../sql/", import.meta.url)))
    .filter((file) => /^\d+.*\.sql$/.test(file) && file !== "010_langgraph_checkpoint.sql").sort();
  for (const file of files) {
    await client.query(await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"));
  }
  await client.query("COMMIT");
  client.release(); client = undefined;
  // 使用 SDK 官方 setup，而不是伪造官方版本号；和 createCheckpointer 入口保持一致。
  const saver = await createCheckpointer();
  await saver.end();
  console.log("Agent 会话、请求、表单、长期记忆和官方 checkpoint 表已初始化；未调用模型。");
} catch {
  await client?.query("ROLLBACK").catch(() => {});
  console.error("Agent 数据库初始化失败，请检查 DATABASE_URL、SQL 文件和建表权限；可修复后重复运行。");
  process.exitCode = 1;
} finally { client?.release(); await pool?.end(); }
