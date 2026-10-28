import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createPool } from "../src/database.ts";
import { LocalDocumentStorage } from "../src/documents/storage.ts";
import { DocumentService } from "../src/documents/service.ts";
import { DocumentProcessor } from "../src/documents/processor.ts";
import { parserForKind } from "../src/documents/parsers/index.ts";
import { chunkDocument } from "../src/documents/chunker.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env",import.meta.url)));
async function fixture() {
  const pool = createPool(); const root = await mkdtemp(join(tmpdir(),"knowledge-ingestion-"));
  const user = randomUUID(); const library = randomUUID(); const otherLibrary = randomUUID();
  await pool.query("INSERT INTO public.knowledge_users(id,username,password_hash) VALUES($1,$2,'unused')",[user,`ingest-${user}`]);
  await pool.query("INSERT INTO public.knowledge_bases(id,owner_id,name) VALUES($1,$2,'A'),($3,$2,'B')",[library,user,otherLibrary]);
  const storage = new LocalDocumentStorage(root); const service = new DocumentService(pool,storage);
  return {pool,root,user,library,otherLibrary,storage,service,processor:new DocumentProcessor(pool,storage),close:async()=>{
    await pool.query("DELETE FROM public.knowledge_documents WHERE knowledge_base_id IN ($1,$2)",[library,otherLibrary]);
    await pool.query("DELETE FROM public.knowledge_bases WHERE owner_id=$1",[user]);
    await pool.query("DELETE FROM public.knowledge_users WHERE id=$1",[user]);
    await pool.end(); await rm(root,{recursive:true,force:true});
  }};
}
test("真实 PostgreSQL：TXT/Markdown/DOCX 全文入库，片段原子保存、重建服务查询、重复执行及跨库隔离", async()=>{
  const env = await fixture();
  try {
    for (const [name,data] of [["规则.md",Buffer.from("# 条件\n七天内且使用不超过两小时。\n\n## 例外\n续费不适用。")],["说明.txt",Buffer.from("正文。\n".repeat(30000)+"TXT_TAIL_SENTINEL")],["文档.docx",await readFile(new URL("./fixtures/full-text.docx",import.meta.url))]] as const) {
      const upload = await env.service.upload(env.user,env.library,name,data); const id = upload.document.id;
      assert.equal(upload.document.processing.status,"pending");
      if(name.endsWith("docx")) await env.pool.query("UPDATE public.knowledge_documents SET processing_status='unsupported' WHERE id=$1",[id]); // 模拟旧版本仅能预览的 Word。
      const competing = await Promise.all([env.processor.processNext(id),new DocumentProcessor(env.pool,env.storage).processNext(id)]);
      assert.equal(competing.filter(Boolean).length,1);
      const restarted = new DocumentService(env.pool,env.storage);
      const detail = await restarted.processing(env.user,env.library,id);
      assert.equal(detail.status,"chunked"); assert.equal(detail.attempt,1);
      assert.deepEqual(detail.steps.map(step=>step.status),["completed","completed","pending","pending","pending"]);
      const content = (await env.pool.query("SELECT text FROM public.knowledge_document_contents WHERE document_id=$1",[id])).rows[0].text as string;
      if (name.endsWith("txt")) { assert.ok(content.length>100000); assert.ok(content.endsWith("TXT_TAIL_SENTINEL")); }
      if (name.endsWith("docx")) { assert.ok(content.length>100000); assert.match(content,/DOCX_END_SENTINEL_7319/); }
      const rows = (await env.pool.query("SELECT id,text,start_offset,end_offset FROM public.knowledge_document_chunks WHERE document_id=$1 ORDER BY ordinal",[id])).rows;
      assert.ok(rows.length>0); for(const row of rows) assert.equal(row.text,content.slice(row.start_offset,row.end_offset));
      assert.ok((await restarted.chunks(env.user,env.library,id,0)).chunks.length<=20);
      await assert.rejects(restarted.chunks(env.user,env.otherLibrary,id,0),/无权访问/);
      await assert.rejects(restarted.chunks(randomUUID(),env.library,id,0),/无权访问/);
      const duplicate = await env.service.upload(env.user,env.library,`改名-${name}`,data);
      assert.equal(duplicate.duplicate,true); assert.equal(duplicate.document.processing.status,"chunked");
      assert.equal(await env.processor.processNext(id),false);
      assert.deepEqual((await env.pool.query("SELECT id FROM public.knowledge_document_chunks WHERE document_id=$1 ORDER BY ordinal",[id])).rows.map(row=>row.id),rows.map(row=>row.id));
    }
  } finally {await env.close();}
});
test("真实 PostgreSQL：空文本失败不产生部分片段；显式重试受 attempt 约束，未知向量结果不能盲重试",async()=>{
  const env = await fixture();
  try {
    const id = (await env.service.upload(env.user,env.library,"空白.txt",Buffer.from(" \n\t "))).document.id;
    await env.processor.processNext(id);
    const failed = await env.service.processing(env.user,env.library,id);
    assert.equal(failed.status,"failed"); assert.equal(failed.canRetry,true);
    assert.equal((await env.pool.query("SELECT id FROM public.knowledge_document_chunks WHERE document_id=$1",[id])).rowCount,0);
    assert.equal((await env.service.retryProcessing(env.user,env.library,id,failed.attempt)).status,"pending");
    assert.equal((await env.service.retryProcessing(env.user,env.library,id,failed.attempt)).status,"pending");
    await env.processor.processNext(id);
    await assert.rejects(env.service.retryProcessing(env.user,env.library,id,failed.attempt),/状态已变化/);
    await assert.rejects(env.service.retryProcessing(env.user,env.otherLibrary,id,2),/无权访问/);
    await env.pool.query("UPDATE public.knowledge_documents SET processing_failed_stage='indexing',processing_error_code='result_unknown' WHERE id=$1",[id]);
    assert.equal((await env.service.processing(env.user,env.library,id)).canRetry,false);
    await assert.rejects(env.service.retryProcessing(env.user,env.library,id,2),/状态已变化/);
  } finally {await env.close();}
});
test("真实 PostgreSQL：原文件损坏明确失败，片段提交异常全部回滚，不提前发布完成",async()=>{
  const env = await fixture();
  try {
    const data = Buffer.from("完整正文。"); const id = (await env.service.upload(env.user,env.library,"资料.txt",data)).document.id;
    const claim = await env.processor.claim(id); assert.ok(claim);
    await env.pool.query("UPDATE public.knowledge_documents SET processing_status='chunking' WHERE id=$1",[id]);
    const parsed = await parserForKind("text").parse(data); const chunks = await chunkDocument(id,parsed);
    await assert.rejects(env.processor.finish(claim,parsed,[{...chunks[0]!,ordinal:-1}]));
    assert.equal((await env.pool.query("SELECT document_id FROM public.knowledge_document_contents WHERE document_id=$1",[id])).rowCount,0);
    assert.equal((await env.service.processing(env.user,env.library,id)).status,"chunking");
    await env.pool.query("UPDATE public.knowledge_documents SET processing_lease_expires_at=now()-interval '1 second' WHERE id=$1",[id]);
    await env.processor.recoverInterrupted(id);
    await env.service.retryProcessing(env.user,env.library,id,1);
    await writeFile(join(env.root,`${claim.storage_key}.blob`),"corrupt");
    await env.processor.processNext(id);
    assert.match((await env.service.processing(env.user,env.library,id)).error!,/原文件/);
  } finally {await env.close();}
});
test("真实 PostgreSQL：旧执行轮次过期后无权提交；新轮次完成不被迟到的旧结果覆盖",async()=>{
  const env = await fixture();
  try {
    const data=Buffer.from("需要保存且不被旧轮次覆盖的正文。");
    const id=(await env.service.upload(env.user,env.library,"轮次.txt",data)).document.id;
    const old=await env.processor.claim(id); assert.ok(old);
    await env.pool.query("UPDATE public.knowledge_documents SET processing_status='chunking',processing_lease_expires_at=now()-interval '1 second' WHERE id=$1",[id]);
    assert.equal(await env.processor.heartbeat(old),false);
    await env.processor.recoverInterrupted(id); await env.service.retryProcessing(env.user,env.library,id,1);
    await env.processor.processNext(id);
    const parsed=await parserForKind("text").parse(data);
    assert.equal(await env.processor.finish(old,parsed,await chunkDocument(id,parsed)),false);
    assert.equal((await env.service.processing(env.user,env.library,id)).status,"chunked");
    assert.equal((await env.service.processing(env.user,env.library,id)).attempt,2);
  } finally {await env.close();}
});
test("真实 PostgreSQL：读取超过处理时限会失败，迟到的读取结果不继续解析或覆盖新状态",async()=>{
  const env=await fixture();
  try {
    const data=Buffer.from("超时后不应继续提交。"); const id=(await env.service.upload(env.user,env.library,"超时.txt",data)).document.id;
    const slow=new DocumentProcessor(env.pool,{...env.storage,read:async()=>{await delay(100);return data;},write:env.storage.write.bind(env.storage),remove:env.storage.remove.bind(env.storage)},20);
    await slow.processNext(id); assert.equal((await env.service.processing(env.user,env.library,id)).status,"failed");
    await delay(120);
    assert.equal((await env.pool.query("SELECT document_id FROM public.knowledge_document_contents WHERE document_id=$1",[id])).rowCount,0);
  } finally {await env.close();}
});
test("真实 PostgreSQL：子进程领取后退出，租约过期标记中断，明确重试后由新实例继续",async()=>{
  const env = await fixture(); let child: ReturnType<typeof fork>|undefined;
  try {
    const id=(await env.service.upload(env.user,env.library,"恢复.txt",Buffer.from("进程重启后从持久记录恢复。"))).document.id;
    child=fork(fileURLToPath(new URL("./helpers/ingestion-child.ts",import.meta.url)),[id],{execArgv:["--import","tsx"],stdio:["ignore","ignore","ignore","ipc"]});
    const message=await once(child,"message",{signal:AbortSignal.timeout(15000)});
    assert.equal(message[0].claimed,id);
    const exited=once(child,"exit"); child.kill(); await exited;
    await env.pool.query("UPDATE public.knowledge_documents SET processing_lease_expires_at=now()-interval '1 second' WHERE id=$1",[id]);
    const restarted=new DocumentProcessor(env.pool,env.storage); await restarted.recoverInterrupted(id);
    const interrupted=await env.service.processing(env.user,env.library,id); assert.match(interrupted.error!,/中断/);
    await env.service.retryProcessing(env.user,env.library,id,interrupted.attempt); await restarted.processNext(id);
    assert.equal((await env.service.processing(env.user,env.library,id)).status,"chunked");
  } finally {if(child && child.exitCode===null)child.kill();await env.close();}
});
