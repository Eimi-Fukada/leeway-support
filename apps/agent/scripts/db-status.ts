import { pathToFileURL } from "node:url";
import { createDatabasePool } from "../src/config/database.ts";
import { inspectDatabase, printDatabaseStatus, type TableCheck } from "../../../scripts/database-status.ts";

export const agentTables: TableCheck[] = [
  {name:"support_service_nonces",file:"004_knowledge_runs.sql",columns:{caller:"text!",nonce:"uuid!",expires_at:"timestamptz!"},constraints:["support_service_nonces_pkey"]},
  {name:"support_knowledge_threads",file:"004_knowledge_runs.sql",columns:{scope:"text!",thread_id:"text!",base_id:"uuid!",revision:"text!"},constraints:["support_knowledge_threads_pkey"]},
  {name:"support_run_options",file:"004_knowledge_runs.sql",columns:{scope:"text!",thread_id:"text!",request_id:"text!",options:"jsonb!"},constraints:["support_run_options_pkey"]},
  { name: "support_memories", file: "001_long_term_memory.sql",
    columns: { scope: "text!", id: "uuid!", version: "int4!", content: "text!", deleted: "bool!", source: "jsonb!", created_at: "timestamptz!", updated_at: "timestamptz!" },
    constraints: ["support_memories_pkey", "support_memories_version_check"], indexes: ["support_memories_pkey"] },
  { name: "support_memory_operations", file: "001_long_term_memory.sql",
    columns: { scope: "text!", operation_id: "text!", payload_hash: "text!", result: "jsonb!", created_at: "timestamptz!" },
    constraints: ["support_memory_operations_pkey"], indexes: ["support_memory_operations_pkey"] },
  { name: "support_information_forms", file: "002_information_forms.sql",
    columns: { id: "uuid!", scope: "text!", thread_id: "text!", run_id: "uuid!", tool_call_id: "text!", spec: "jsonb!", status: "text!", expires_at: "timestamptz!", created_at: "timestamptz!", submission_id: "uuid", submission_hash: "text", result: "jsonb", interrupt_id: "text" },
    constraints: ["support_information_forms_pkey", "support_information_forms_status_check", "support_information_forms_scope_thread_id_run_id_key"],
    indexes: ["support_information_forms_pkey", "support_information_forms_scope_thread_id_run_id_key", "support_information_forms_thread"] },
  { name: "support_conversation_requests", file: "003_conversations.sql",
    columns: { scope: "text!", thread_id: "text!", request_id: "text!", run_id: "uuid!", payload_hash: "text!", status: "text!", history_complete: "bool!", metadata_required: "bool!", request_kind: "text!", result: "jsonb", created_at: "timestamptz!", updated_at: "timestamptz!", sequence: "int8!" },
    constraints: ["support_conversation_requests_pkey", "support_conversation_requests_status_check"], indexes: ["support_conversation_requests_pkey"] },
  { name: "support_conversation_messages", file: "003_conversations.sql",
    columns: { scope: "text!", thread_id: "text!", id: "text!", role: "text!", content: "text!", request_id: "text!", sequence: "int8!", created_at: "timestamptz!" },
    constraints: ["support_conversation_messages_pkey", "support_conversation_messages_role_check"], indexes: ["support_conversation_messages_pkey"] },
  { name: "checkpoint_migrations", file: "010_langgraph_checkpoint.sql", columns: { v: "int4!" },
    constraints: ["checkpoint_migrations_pkey"], indexes: ["checkpoint_migrations_pkey"] },
  { name: "checkpoints", file: "010_langgraph_checkpoint.sql",
    columns: { thread_id: "text!", checkpoint_ns: "text!", checkpoint_id: "text!", parent_checkpoint_id: "text", type: "text", checkpoint: "jsonb!", metadata: "jsonb!" },
    constraints: ["checkpoints_pkey"], indexes: ["checkpoints_pkey"] },
  { name: "checkpoint_blobs", file: "010_langgraph_checkpoint.sql",
    columns: { thread_id: "text!", checkpoint_ns: "text!", channel: "text!", version: "text!", type: "text!", blob: "bytea" },
    constraints: ["checkpoint_blobs_pkey"], indexes: ["checkpoint_blobs_pkey"] },
  { name: "checkpoint_writes", file: "010_langgraph_checkpoint.sql",
    columns: { thread_id: "text!", checkpoint_ns: "text!", checkpoint_id: "text!", task_id: "text!", idx: "int4!", channel: "text!", type: "text", blob: "bytea!", task_path: "text!" },
    constraints: ["checkpoint_writes_pkey"], indexes: ["checkpoint_writes_pkey"] },
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool: ReturnType<typeof createDatabasePool> | undefined;
  try {
    pool = createDatabasePool();
    const client = await pool.connect();
    try {
      if (!printDatabaseStatus("Agent", await inspectDatabase(client, agentTables))) process.exitCode = 1;
      const migration = await client.query<{ exists: boolean }>("SELECT to_regclass('public.checkpoint_migrations') IS NOT NULL AS exists");
      if (migration.rows[0]?.exists) {
        const versions = await client.query<{ v: number }>("SELECT v FROM public.checkpoint_migrations ORDER BY v");
        if (versions.rows.map((row) => row.v).join(",") !== "0,1,2,3,4,5") {
          console.log("[不符] checkpoint 官方版本应为 0–5，请核对当前锁定 SDK 与 010_langgraph_checkpoint.sql");
          process.exitCode = 1;
        }
      }
    } finally { client.release(); }
  } catch {
    console.error("Agent 状态检查未完成，请检查数据库配置、连接及读取权限；未修改数据库。");
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
