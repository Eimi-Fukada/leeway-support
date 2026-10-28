import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/database.ts";
import { knowledgeTables } from "../scripts/db-status.ts";
import { inspectDatabase } from "../../../scripts/database-status.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));

test("真实 PostgreSQL：SQL 目录可独立初始化全部表，重复执行不重置账号并保留约束", async () => {
  const pool = createPool();
  const client = await pool.connect();
  try {
    const directory = new URL("../sql/", import.meta.url);
    const names = (await readdir(directory)).filter((name: string) => /^\d+.*\.sql$/.test(name)).sort();
    const sql = (await Promise.all(names.map((name: string) => readFile(new URL(name, directory), "utf8")))).join("\n");
    const expected = ["knowledge_bases", "knowledge_document_chunks", "knowledge_document_contents", "knowledge_documents", "knowledge_sessions", "knowledge_users"];
    const definitions = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(knowledge_\w+)/g)].map((match) => match[1]).sort();
    assert.deepEqual(definitions, expected);
    // 用当前产品数据库连接的临时表验证空结构，绝不删除或改写 public 中的实际数据。
    const temporarySql = sql.replaceAll("CREATE TABLE IF NOT EXISTS public.", "CREATE TEMP TABLE IF NOT EXISTS pg_temp.")
      .replaceAll("public.", "pg_temp.");
    await client.query("BEGIN");
    await client.query(temporarySql);
    const created = await client.query<{ relname: string }>("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind='r' ORDER BY relname");
    assert.deepEqual(created.rows.map((row) => row.relname), expected);
    const account = await client.query<{ id: string; password_hash: string }>("SELECT id,password_hash FROM pg_temp.knowledge_users WHERE username='support'");
    assert.equal(account.rowCount, 1);
    assert.match(account.rows[0]!.password_hash, /^scrypt:32768:8:3:/);
    await client.query("UPDATE pg_temp.knowledge_users SET password_hash='changed-for-idempotency-check' WHERE username='support'");
    await client.query(temporarySql);
    const repeated = await client.query<{ password_hash: string }>("SELECT password_hash FROM pg_temp.knowledge_users WHERE username='support'");
    assert.equal(repeated.rows[0]!.password_hash, "changed-for-idempotency-check");
    assert.equal((await client.query("SELECT id FROM pg_temp.knowledge_users")).rowCount, 1);
    await client.query("INSERT INTO pg_temp.knowledge_bases(id,owner_id,name) VALUES('fef01111-1111-4111-8111-111111111111',$1,'知识库')", [account.rows[0]!.id]);
    await client.query("SAVEPOINT duplicate_name");
    await assert.rejects(client.query("INSERT INTO pg_temp.knowledge_bases(id,owner_id,name) VALUES('fef02222-2222-4222-8222-222222222222',$1,'知识库')", [account.rows[0]!.id]),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23505");
    await client.query("ROLLBACK TO SAVEPOINT duplicate_name");
    const foreignKeys = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_constraint WHERE connamespace=pg_my_temp_schema() AND contype='f'");
    assert.equal(foreignKeys.rows[0]!.count, 5);
    const doc="fef08888-8888-4888-8888-888888888888";
    await client.query(`INSERT INTO pg_temp.knowledge_documents(id,knowledge_base_id,name,kind,size,sha256,storage_key,processing_status,embedding_profile)
      VALUES($1,'fef01111-1111-4111-8111-111111111111','向量完成.txt','text',10,$2,$3,'embedded','{"model":"test","dimensions":3}')`,[doc,"a".repeat(64),"fef09999-9999-4999-8999-999999999999"]);
    await client.query(temporarySql);
    assert.equal((await client.query("SELECT processing_status FROM pg_temp.knowledge_documents WHERE id=$1",[doc])).rows[0].processing_status,"embedded");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release(); await pool.end();
  }
});

test("真实 PostgreSQL：旧文档补齐处理字段，重复初始化不重置执行/失败状态或原文件信息", async () => {
  const pool = createPool(); const client = await pool.connect();
  const temp = (sql: string) => sql.replaceAll("CREATE TABLE IF NOT EXISTS public.", "CREATE TEMP TABLE IF NOT EXISTS pg_temp.").replaceAll("public.", "pg_temp.");
  try {
    await client.query("BEGIN");
    for (const name of ["001_schema.sql", "002_seed_support.sql", "003_documents.sql"]) {
      await client.query(temp(await readFile(new URL(`../sql/${name}`, import.meta.url), "utf8")));
    }
    const user = (await client.query("SELECT id FROM pg_temp.knowledge_users WHERE username='support'")).rows[0].id;
    const library = "fef01111-1111-4111-8111-111111111111";
    await client.query("INSERT INTO pg_temp.knowledge_bases(id,owner_id,name) VALUES($1,$2,'旧资料')", [library, user]);
    await client.query(`INSERT INTO pg_temp.knowledge_documents(id,knowledge_base_id,name,kind,size,sha256,storage_key)
      VALUES('fef02222-2222-4222-8222-222222222222',$1,'旧文本.txt','text',12,$2,'fef04444-4444-4444-8444-444444444444'),
      ('fef03333-3333-4333-8333-333333333333',$1,'旧PDF.pdf','pdf',24,$3,'fef05555-5555-4555-8555-555555555555')`, [library, "a".repeat(64), "b".repeat(64)]);
    await client.query("INSERT INTO pg_temp.knowledge_documents(id,knowledge_base_id,name,kind,size,sha256,storage_key) VALUES('fef06666-6666-4666-8666-666666666666',$1,'旧Word.docx','docx',32,$2,'fef07777-7777-4777-8777-777777777777')",[library,"c".repeat(64)]);
    const snapshot = (await client.query("SELECT id,name,kind,size,sha256,storage_key,created_at FROM pg_temp.knowledge_documents ORDER BY id")).rows;
    const upgrade = temp(await readFile(new URL("../sql/004_document_processing.sql", import.meta.url), "utf8"));
    await client.query(upgrade);
    assert.deepEqual((await client.query("SELECT processing_status FROM pg_temp.knowledge_documents ORDER BY id")).rows.map((row) => row.processing_status), ["pending", "unsupported", "unsupported"]);
    await client.query("UPDATE pg_temp.knowledge_documents SET processing_status='failed',processing_failed_stage='chunking',processing_error_code='chunk_failed' WHERE kind='text'");
    await client.query(upgrade);
    assert.deepEqual((await client.query("SELECT id,name,kind,size,sha256,storage_key,created_at FROM pg_temp.knowledge_documents ORDER BY id")).rows, snapshot);
    assert.equal((await client.query("SELECT processing_status FROM pg_temp.knowledge_documents WHERE kind='text'")).rows[0].processing_status, "failed");
    const ingestion=temp(await readFile(new URL("../sql/005_document_ingestion.sql",import.meta.url),"utf8"));
    await client.query(ingestion);
    assert.equal((await client.query("SELECT processing_status FROM pg_temp.knowledge_documents WHERE kind='docx'")).rows[0].processing_status,"pending");
    await client.query("UPDATE pg_temp.knowledge_documents SET processing_status='chunked' WHERE kind='docx'");
    await client.query(upgrade);await client.query(ingestion);
    assert.equal((await client.query("SELECT processing_status FROM pg_temp.knowledge_documents WHERE kind='docx'")).rows[0].processing_status,"chunked");
    assert.equal((await client.query("SELECT processing_status FROM pg_temp.knowledge_documents WHERE kind='text'")).rows[0].processing_status,"failed");
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); await pool.end(); }
});

test("真实 PostgreSQL：只读状态检查识别空库、缺字段、类型/非空错误与缺索引/约束，不初始化账号", async () => {
  const pool = createPool(); const client = await pool.connect();
  try {
    await client.query("CREATE TEMP TABLE status_marker(id integer)");
    const schema = (await client.query<{ name: string }>("SELECT nspname AS name FROM pg_namespace WHERE oid=pg_my_temp_schema()")).rows[0]!.name;
    const empty = await inspectDatabase(client, knowledgeTables, schema);
    assert.ok(empty.every((status) => status.issues.includes("缺少表")));
    assert.equal((await client.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind='r'")).rowCount, 1);
    const directory = new URL("../sql/", import.meta.url);
    const files = (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
    const sql = (await Promise.all(files.map((file) => readFile(new URL(file, directory), "utf8")))).join("\n")
      .replaceAll("CREATE TABLE IF NOT EXISTS public.", "CREATE TEMP TABLE IF NOT EXISTS pg_temp.").replaceAll("public.", "pg_temp.");
    await client.query(sql);
    await client.query("SET default_transaction_read_only=on");
    assert.ok((await inspectDatabase(client, knowledgeTables, schema)).every((status) => status.issues.length === 0));
    await assert.rejects(client.query("CREATE TEMP TABLE status_must_not_be_created(id integer)"),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "25006");
    await client.query("SET default_transaction_read_only=off");
    await client.query("ALTER TABLE pg_temp.knowledge_documents DROP COLUMN sha256");
    await client.query("ALTER TABLE pg_temp.knowledge_users ALTER COLUMN active DROP NOT NULL, ALTER COLUMN username TYPE varchar(64)");
    await client.query("DROP INDEX pg_temp.knowledge_sessions_expiry");
    await client.query("SET default_transaction_read_only=on");
    const drift = await inspectDatabase(client, knowledgeTables, schema);
    assert.ok(drift.find((status) => status.name === "knowledge_documents")!.issues.includes("缺少字段 sha256"));
    assert.ok(drift.find((status) => status.name === "knowledge_documents")!.issues.some((issue) => issue.includes("knowledge_documents_knowledge_base_id_sha256_key")));
    assert.ok(drift.find((status) => status.name === "knowledge_users")!.issues.includes("字段 active 可空性不符"));
    assert.ok(drift.find((status) => status.name === "knowledge_users")!.issues.includes("字段 username 类型应为 text"));
    assert.ok(drift.find((status) => status.name === "knowledge_sessions")!.issues.some((issue) => issue.includes("knowledge_sessions_expiry")));
    assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_temp.knowledge_users")).rows[0].count, 1);
    assert.equal((await client.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only, "on");
  } finally { client.release(); await pool.end(); }
});
