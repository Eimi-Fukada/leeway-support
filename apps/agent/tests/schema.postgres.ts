import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabasePool } from "../src/config/database.ts";
import { readSupportSchema, supportSchemaFiles } from "../src/config/schema.ts";
import { agentTables } from "../scripts/db-status.ts";
import { inspectDatabase } from "../../../scripts/database-status.ts";

test("真实 PostgreSQL：Agent SQL 可独立初始化全部表并重复执行，消息/状态/旧字段迁移可用", async () => {
  const pool = createDatabasePool(); const client = await pool.connect();
  try {
    const appSql = (await Promise.all(supportSchemaFiles.map((file) => readSupportSchema(file)))).join("\n");
    const checkpoint = await readFile(new URL("../sql/010_langgraph_checkpoint.sql", import.meta.url), "utf8");
    const sql = (appSql + "\n" + checkpoint)
      .replace(/^BEGIN;\s*$/gm, "").replace(/^COMMIT;\s*$/gm, "")
      .replaceAll("CREATE TABLE IF NOT EXISTS public.", "CREATE TEMP TABLE IF NOT EXISTS pg_temp.")
      .replaceAll('CREATE TABLE IF NOT EXISTS "public".', "CREATE TEMP TABLE IF NOT EXISTS pg_temp.")
      .replaceAll('"public".', "pg_temp.").replaceAll("public.", "pg_temp.");
    await client.query("BEGIN");
    await client.query(sql);
    const expected = ["checkpoint_blobs", "checkpoint_migrations", "checkpoint_writes", "checkpoints", "support_conversation_messages", "support_conversation_requests", "support_information_forms", "support_knowledge_threads", "support_memories", "support_memory_operations", "support_run_options", "support_service_nonces"];
    const tables = await client.query<{ relname: string }>("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind='r' ORDER BY relname");
    assert.deepEqual(tables.rows.map((row) => row.relname), expected);
    await client.query("INSERT INTO pg_temp.support_conversation_requests(scope,thread_id,request_id,run_id,payload_hash,status) VALUES('scope','thread','message',$1,'hash','running')", [randomUUID()]);
    await client.query("INSERT INTO pg_temp.support_conversation_messages(scope,thread_id,id,role,content,request_id) VALUES('scope','thread','message','user','原问题','message')");
    await client.query("ALTER TABLE pg_temp.support_conversation_requests DROP COLUMN history_complete, DROP COLUMN request_kind");
    await client.query("ALTER TABLE pg_temp.support_information_forms DROP COLUMN interrupt_id");
    await client.query(sql);
    const record = await client.query<{ history_complete: boolean; request_kind: string }>("SELECT history_complete,request_kind FROM pg_temp.support_conversation_requests WHERE request_id='message'");
    assert.deepEqual(record.rows[0], { history_complete: true, request_kind: "legacy" });
    assert.equal((await client.query("SELECT content FROM pg_temp.support_conversation_messages")).rows[0].content, "原问题");
    const versions = await client.query<{ v: number }>("SELECT v FROM pg_temp.checkpoint_migrations ORDER BY v");
    assert.deepEqual(versions.rows.map((row) => row.v), [0,1,2,3,4,5]);
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); await pool.end(); }
});

test("真实 PostgreSQL：Agent 只读状态检查不创建表，完整 SQL 满足检查，旧字段和官方字段缺失可定位", async () => {
  const pool = createDatabasePool(); const client = await pool.connect();
  try {
    await client.query("CREATE TEMP TABLE status_marker(id integer)");
    const schema = (await client.query<{ name: string }>("SELECT nspname AS name FROM pg_namespace WHERE oid=pg_my_temp_schema()")).rows[0]!.name;
    assert.ok((await inspectDatabase(client, agentTables, schema)).every((status) => status.issues.includes("缺少表")));
    const appSql = (await Promise.all(supportSchemaFiles.map((file) => readSupportSchema(file)))).join("\n");
    const checkpoint = await readFile(new URL("../sql/010_langgraph_checkpoint.sql", import.meta.url), "utf8");
    const sql = (appSql + "\n" + checkpoint).replace(/^BEGIN;\s*$/gm, "").replace(/^COMMIT;\s*$/gm, "")
      .replaceAll("CREATE TABLE IF NOT EXISTS public.", "CREATE TEMP TABLE IF NOT EXISTS pg_temp.")
      .replaceAll('CREATE TABLE IF NOT EXISTS "public".', "CREATE TEMP TABLE IF NOT EXISTS pg_temp.")
      .replaceAll('"public".', "pg_temp.").replaceAll("public.", "pg_temp.");
    await client.query(sql);
    await client.query("SET default_transaction_read_only=on");
    assert.ok((await inspectDatabase(client, agentTables, schema)).every((status) => status.issues.length === 0));
    await client.query("SET default_transaction_read_only=off");
    await client.query("ALTER TABLE pg_temp.support_information_forms DROP COLUMN interrupt_id");
    await client.query("ALTER TABLE pg_temp.support_conversation_requests DROP COLUMN request_kind");
    await client.query("ALTER TABLE pg_temp.checkpoint_writes DROP COLUMN task_path");
    await client.query("SET default_transaction_read_only=on");
    const missing = await inspectDatabase(client, agentTables, schema);
    for (const [table, column] of [["support_information_forms", "interrupt_id"], ["support_conversation_requests", "request_kind"], ["checkpoint_writes", "task_path"]]) {
      assert.ok(missing.find((status) => status.name === table)!.issues.includes(`缺少字段 ${column}`));
    }
    assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_temp.support_conversation_requests")).rows[0].count, 0);
    assert.equal((await client.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only, "on");
  } finally { client.release(); await pool.end(); }
});
