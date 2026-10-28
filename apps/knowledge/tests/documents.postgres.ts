import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/database.ts";
import { DocumentService } from "../src/documents/service.ts";
import { LocalDocumentStorage } from "../src/documents/storage.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
test("真实 PostgreSQL/磁盘：原文上传、并发去重、跨库独立、重建服务读取与越权/损坏拒绝", async () => {
  const pool = createPool(); const root = await mkdtemp(join(tmpdir(), "leeway-documents-pg-"));
  const user = randomUUID(); const otherUser = randomUUID(); const a = randomUUID(); const b = randomUUID();
  try {
    await pool.query("INSERT INTO public.knowledge_users(id,username,password_hash) VALUES($1,$2,$3)", [user, `docs-${user}`, "unused-test-hash"]);
    await pool.query("INSERT INTO public.knowledge_bases(id,owner_id,name) VALUES($1,$2,$3),($4,$2,$5)", [a,user,"库A",b,"库B"]);
    const store = new LocalDocumentStorage(root); const service = new DocumentService(pool, store);
    const content = Buffer.from("# 产品规则\n只属于指定知识库。");
    const results = await Promise.all([service.upload(user,a,"资料.md",content), service.upload(user,a,"改名.md",content)]);
    assert.equal(results[0]!.document.id,results[1]!.document.id);
    assert.equal(results.filter((result) => result.duplicate).length,1);
    assert.equal((await readdir(root)).length,1);
    const restarted = new DocumentService(pool,new LocalDocumentStorage(root));
    const list = await restarted.list(user,a); assert.equal(list.length,1); assert.equal(list[0]!.status,"stored");
    assert.equal(list[0]!.processing.status, "pending");
    assert.equal((await restarted.processing(user,a,list[0]!.id)).steps.every((step) => step.status === "pending"), true);
    assert.equal((await restarted.original(user,a,list[0]!.id)).data.toString(),content.toString());
    assert.equal((await restarted.preview(user,a,list[0]!.id)).text,content.toString());
    const copy = await service.upload(user,b,"资料.md",content); assert.notEqual(copy.document.id,list[0]!.id);
    await assert.rejects(restarted.list(otherUser,a),/无权访问/);
    await assert.rejects(restarted.upload(otherUser,a,"坏.txt",Buffer.from("x")),/无权访问/);
    await assert.rejects(restarted.original(user,b,list[0]!.id),/无权访问/);
    await assert.rejects(restarted.processing(otherUser,a,list[0]!.id),/无权访问/);
    await assert.rejects(restarted.processing(user,b,list[0]!.id),/无权访问/);
    await assert.rejects(restarted.processing(user,a,"invalid-id"),/无权访问/);
    const key = (await pool.query<{storage_key:string}>("SELECT storage_key FROM public.knowledge_documents WHERE id=$1",[list[0]!.id])).rows[0]!.storage_key;
    await writeFile(join(root,`${key}.blob`),"corrupted");
    await assert.rejects(restarted.original(user,a,list[0]!.id),/校验失败/);
    const failing = new DocumentService(pool,{read:store.read.bind(store),remove:store.remove.bind(store),write:async()=>{throw new Error("disk failed");}});
    await assert.rejects(failing.upload(user,a,"失败.txt",Buffer.from("new content")),/disk failed/);
    assert.equal((await service.list(user,a)).length,1);
  } finally {
    await pool.query("DELETE FROM public.knowledge_documents WHERE knowledge_base_id IN ($1,$2)",[a,b]);
    await pool.query("DELETE FROM public.knowledge_bases WHERE owner_id=$1",[user]);
    await pool.query("DELETE FROM public.knowledge_users WHERE id=$1",[user]);
    await pool.end(); await rm(root,{recursive:true,force:true});
  }
});

test("真实 PostgreSQL：处理结果跨服务恢复、只读查询、重复上传不重置，失败与格式约束生效", async () => {
  const pool = createPool(); const root = await mkdtemp(join(tmpdir(), "leeway-processing-pg-"));
  const user = randomUUID(); const library = randomUUID();
  try {
    await pool.query("INSERT INTO public.knowledge_users(id,username,password_hash) VALUES($1,$2,'unused')", [user, `progress-${user}`]);
    await pool.query("INSERT INTO public.knowledge_bases(id,owner_id,name) VALUES($1,$2,'处理状态')", [library, user]);
    const storage = new LocalDocumentStorage(root); const service = new DocumentService(pool, storage);
    const content = Buffer.from("# 状态测试\n这是完整原文件，读取处理状态不应读取或改写原文。");
    const uploaded = await service.upload(user, library, "状态.md", content);
    const id = uploaded.document.id;
    const onlyStatus = new DocumentService(pool, { write: async () => { throw new Error("must not write"); }, read: async () => { throw new Error("must not read"); }, remove: async () => { throw new Error("must not remove"); } });
    const before = (await pool.query("SELECT to_jsonb(d) AS value FROM public.knowledge_documents d WHERE id=$1", [id])).rows[0].value;
    await onlyStatus.processing(user, library, id); await onlyStatus.processing(user, library, id);
    assert.deepEqual((await pool.query("SELECT to_jsonb(d) AS value FROM public.knowledge_documents d WHERE id=$1", [id])).rows[0].value, before);
    // 模拟未来执行器写入结果；产品当前没有更新状态的 HTTP 接口。
    await pool.query("UPDATE public.knowledge_documents SET processing_status='embedding',processing_updated_at=now() WHERE id=$1", [id]);
    assert.equal((await onlyStatus.processing(user, library, id)).steps[2]!.status, "running");
    const repeated = await service.upload(user, library, "改名.md", content);
    assert.equal(repeated.duplicate, true); assert.equal(repeated.document.processing.status, "embedding");
    await pool.query("UPDATE public.knowledge_documents SET processing_status='failed',processing_failed_stage='embedding',processing_error_code='embedding_failed',processing_updated_at=now() WHERE id=$1", [id]);
    const failed = await onlyStatus.processing(user, library, id);
    assert.equal(failed.status, "failed"); assert.match(failed.error!, /向量化服务/);
    assert.equal((await onlyStatus.list(user, library))[0]!.processing.status, "failed");
    await assert.rejects(pool.query("UPDATE public.knowledge_documents SET processing_status='ready' WHERE id=$1", [id]),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514");
    await pool.query("UPDATE public.knowledge_documents SET processing_status='ready',processing_failed_stage=NULL,processing_error_code=NULL WHERE id=$1", [id]);
    assert.ok((await onlyStatus.processing(user, library, id)).steps.every((step) => step.status === "completed"));
    await assert.rejects(service.upload(user, library, "资料.pdf", Buffer.from("%PDF-1.4\nmock PDF data\n%%EOF")), /暂时支持/);
    const pdfId = randomUUID();
    await pool.query("INSERT INTO public.knowledge_documents(id,knowledge_base_id,name,kind,size,sha256,storage_key,processing_status) VALUES($1,$2,'历史PDF.pdf','pdf',12,$3,$4,'unsupported')", [pdfId, library, "a".repeat(64), randomUUID()]);
    assert.ok((await onlyStatus.processing(user, library, pdfId)).steps.every((step) => step.status === "unsupported"));
  } finally {
    await pool.query("DELETE FROM public.knowledge_documents WHERE knowledge_base_id=$1", [library]);
    await pool.query("DELETE FROM public.knowledge_bases WHERE id=$1", [library]);
    await pool.query("DELETE FROM public.knowledge_users WHERE id=$1", [user]);
    await pool.end(); await rm(root, { recursive: true, force: true });
  }
});
