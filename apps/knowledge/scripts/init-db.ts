import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/database.ts";
import type pg from "pg";

const env = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(env)) process.loadEnvFile(env);
let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
try {
  pool = createPool();
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(461992305)");
  const files = (await readdir(new URL("../sql/", import.meta.url))).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  for (const file of files) {
    await client.query(await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"));
  }
  await client.query("COMMIT");
  console.log("知识库表和 support 账号已初始化；重复运行不会重置现有密码。");
} catch {
  await client?.query("ROLLBACK").catch(() => {});
  console.error("知识库初始化失败，请检查数据库配置、建表权限与迁移文件。");
  process.exitCode = 1;
} finally { client?.release(); await pool?.end(); }
