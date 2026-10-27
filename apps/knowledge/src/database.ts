import pg from "pg";

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error("请配置知识库 DATABASE_URL。");
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error();
  } catch { throw new Error("知识库数据库配置无效。"); }
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000,
    query_timeout: 10000, statement_timeout: 10000, application_name: "leeway-knowledge" });
  pool.on("error", () => console.error("[知识库] 数据库连接异常。"));
  return pool;
}
