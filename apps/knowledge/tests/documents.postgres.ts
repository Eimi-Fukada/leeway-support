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
    assert.equal((await restarted.original(user,a,list[0]!.id)).data.toString(),content.toString());
    assert.equal((await restarted.preview(user,a,list[0]!.id)).text,content.toString());
    const copy = await service.upload(user,b,"资料.md",content); assert.notEqual(copy.document.id,list[0]!.id);
    await assert.rejects(restarted.list(otherUser,a),/无权访问/);
    await assert.rejects(restarted.upload(otherUser,a,"坏.txt",Buffer.from("x")),/无权访问/);
    await assert.rejects(restarted.original(user,b,list[0]!.id),/无权访问/);
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
