import pg from "pg";
import { loadAgentEnv } from "./env.ts";

export function createDatabasePool(connectionString?: string): pg.Pool {
  if (connectionString === undefined) {
    loadAgentEnv();
    connectionString = process.env.DATABASE_URL?.trim();
  }
  if (!connectionString) throw new Error("数据库配置缺失：请配置 DATABASE_URL。");
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length <= 1) {
      throw new Error();
    }
  } catch {
    throw new Error("数据库配置无效：DATABASE_URL 必须包含 PostgreSQL 主机和数据库名。");
  }

  // 显式使用 Pool 以设置连接/查询截止时间；不输出连接串或原始数据库错误。
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
  pool.on("error", () => {
    // pg 的空闲连接也可能报错；只留安全的诊断，不让原始错误泄露凭证。
    console.error("[数据库] 空闲连接异常，后续读写将重新获取连接。");
  });
  return pool;
}
