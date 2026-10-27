import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPool } from "../src/database.ts";
import { inspectDatabase, printDatabaseStatus, type TableCheck } from "../../../scripts/database-status.ts";

export const knowledgeTables: TableCheck[] = [
  { name: "knowledge_users", file: "001_schema.sql",
    columns: { id: "uuid!", username: "text!", password_hash: "text!", active: "bool!", created_at: "timestamptz!" },
    constraints: ["knowledge_users_pkey", "knowledge_users_username_key", "knowledge_users_username_check"] },
  { name: "knowledge_sessions", file: "001_schema.sql",
    columns: { token_hash: "text!", user_id: "uuid!", expires_at: "timestamptz!", created_at: "timestamptz!" },
    constraints: ["knowledge_sessions_pkey", "knowledge_sessions_token_hash_check", "knowledge_sessions_user_id_fkey"],
    indexes: ["knowledge_sessions_pkey", "knowledge_sessions_expiry", "knowledge_sessions_user"] },
  { name: "knowledge_bases", file: "001_schema.sql",
    columns: { id: "uuid!", owner_id: "uuid!", name: "text!", description: "text!", created_at: "timestamptz!" },
    constraints: ["knowledge_bases_pkey", "knowledge_bases_owner_id_fkey", "knowledge_bases_name_check", "knowledge_bases_description_check"],
    indexes: ["knowledge_bases_pkey", "knowledge_bases_owner_name"] },
  { name: "knowledge_documents", file: "003_documents.sql",
    columns: { id: "uuid!", knowledge_base_id: "uuid!", name: "text!", kind: "text!", size: "int4!", sha256: "text!", storage_key: "uuid!", created_at: "timestamptz!" },
    constraints: ["knowledge_documents_pkey", "knowledge_documents_knowledge_base_id_fkey", "knowledge_documents_name_check", "knowledge_documents_kind_check", "knowledge_documents_size_check", "knowledge_documents_sha256_check", "knowledge_documents_storage_key_key", "knowledge_documents_knowledge_base_id_sha256_key"],
    indexes: ["knowledge_documents_pkey", "knowledge_documents_storage_key_key", "knowledge_documents_knowledge_base_id_sha256_key", "knowledge_documents_library"] },
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(env)) process.loadEnvFile(env);
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    pool = createPool();
    const client = await pool.connect();
    try {
      const statuses = await inspectDatabase(client, knowledgeTables);
      if (!printDatabaseStatus("知识库", statuses)) process.exitCode = 1;
      if (!statuses.find((status) => status.name === "knowledge_users")?.issues.length) {
        const account = await client.query<{ active: boolean }>("SELECT active FROM public.knowledge_users WHERE username=$1", ["support"]);
        if (!account.rows[0]) {
          console.log("[缺失] support 账号 → sql/002_seed_support.sql");
          process.exitCode = 1;
        } else console.log(`[账号] support 已存在${account.rows[0].active ? "" : "，当前已禁用"}（未校验或修改密码）`);
      }
    } finally { client.release(); }
  } catch {
    console.error("知识库状态检查未完成，请检查数据库配置、连接及读取权限；未修改数据库。");
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
