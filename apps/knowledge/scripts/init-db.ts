import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  await client.query(`CREATE TABLE IF NOT EXISTS public.knowledge_schema_migrations(
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const version of ["001_schema.sql", "002_seed_support.sql", "003_documents.sql"]) {
    const sql = await readFile(new URL(`../sql/${version}`, import.meta.url), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const previous = await client.query<{ checksum: string }>("SELECT checksum FROM public.knowledge_schema_migrations WHERE version=$1", [version]);
    if (previous.rows[0]) {
      if (previous.rows[0].checksum !== checksum) throw new Error("已应用的 SQL 文件发生改变，请创建新迁移。");
      continue;
    }
    await client.query(sql);
    await client.query("INSERT INTO public.knowledge_schema_migrations(version,checksum) VALUES($1,$2)", [version, checksum]);
  }
  await client.query("COMMIT");
  console.log("知识库表和 support 账号已初始化；重复运行不会重置现有密码。");
} catch {
  await client?.query("ROLLBACK").catch(() => {});
  console.error("知识库初始化失败，请检查数据库配置、建表权限与迁移文件。");
  process.exitCode = 1;
} finally { client?.release(); await pool?.end(); }
