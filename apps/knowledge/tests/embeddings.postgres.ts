import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool } from "../src/database.ts";
import { DocumentService } from "../src/documents/service.ts";
import { DocumentProcessor } from "../src/documents/processor.ts";
import { LocalDocumentStorage } from "../src/documents/storage.ts";
import { createEmbeddingClient,type EmbeddingClient } from "../src/embeddings/client.ts";
import { EmbeddingProcessor } from "../src/embeddings/processor.ts";
import { fileURLToPath } from "node:url";
process.loadEnvFile(fileURLToPath(new URL("../.env",import.meta.url)));
async function fixture(){
  const pool=createPool();const root=await mkdtemp(join(tmpdir(),"embedding-pg-"));const user=randomUUID(),library=randomUUID();
  await pool.query("INSERT INTO public.knowledge_users(id,username,password_hash) VALUES($1,$2,'unused')",[user,`embedding-${user}`]);
  await pool.query("INSERT INTO public.knowledge_bases(id,owner_id,name) VALUES($1,$2,'嵌入测试')",[library,user]);
  const storage=new LocalDocumentStorage(root),service=new DocumentService(pool,storage);
  const id=(await service.upload(user,library,"embedding.txt",Buffer.from("完整规则：购买七天内且使用不超过两小时可以申请。\n".repeat(100)))).document.id;
  await new DocumentProcessor(pool,storage).processNext(id);
  const client=createEmbeddingClient({provider:"ollama",baseUrl:"http://127.0.0.1:11434",model:"test",revision:"v1",dimensions:3,batchSize:1,timeoutMs:1000,documentPrefix:"",queryPrefix:""},async(_url,init)=>{
    const input=JSON.parse(String(init!.body)).input;return Response.json({model:"test",embeddings:input.map(()=>[1,2,3])});
  });
  return {pool,user,library,id,service,client,close:async()=>{await pool.query("DELETE FROM public.knowledge_documents WHERE knowledge_base_id=$1",[library]);await pool.query("DELETE FROM public.knowledge_bases WHERE id=$1",[library]);await pool.query("DELETE FROM public.knowledge_users WHERE id=$1",[user]);await pool.end();await rm(root,{recursive:true,force:true});}};
}
test("真实 PostgreSQL＋模拟嵌入：向量全量提交和模型标识持久化，重复领取不调用模型，完成仅前三步",async()=>{
  const f=await fixture();try{
    const worker=new EmbeddingProcessor(f.pool,f.client);
    const results=await Promise.all([worker.processNext(f.id),worker.processNext(f.id)]);assert.equal(results.filter(Boolean).length,1);
    const state=await f.service.processing(f.user,f.library,f.id);assert.equal(state.status,"embedded");assert.deepEqual(state.steps.map(step=>step.status),["completed","completed","completed","pending","pending"]);
    const rows=await f.pool.query("SELECT embedding FROM public.knowledge_document_chunks WHERE document_id=$1",[f.id]);assert.ok(rows.rows.every(row=>JSON.stringify(row.embedding)==="[1,2,3]"));
    assert.equal((await f.pool.query("SELECT embedding_profile FROM public.knowledge_documents WHERE id=$1",[f.id])).rows[0].embedding_profile.id,f.client.profile.id);
    assert.equal(await worker.processNext(f.id),false);
  }finally{await f.close();}
});
test("真实 PostgreSQL＋模拟嵌入：部分批次失败不提交任何向量，重试复用片段，不重新解析全文",async()=>{
  const f=await fixture();try{
    let calls=0;const broken:EmbeddingClient={...f.client,embedDocuments:async()=>{calls++;if(calls>1)throw new Error("provider secret");return [[1,2,3]];}};
    const chunks=(await f.pool.query("SELECT id FROM public.knowledge_document_chunks WHERE document_id=$1 ORDER BY ordinal",[f.id])).rows;
    await new EmbeddingProcessor(f.pool,broken).processNext(f.id);assert.ok(calls>1);
    assert.equal((await f.pool.query("SELECT id FROM public.knowledge_document_chunks WHERE document_id=$1 AND embedding IS NOT NULL",[f.id])).rowCount,0);
    const failed=await f.service.processing(f.user,f.library,f.id);assert.equal(failed.canRetry,true);assert.ok(!failed.error!.includes("secret"));
    assert.equal((await f.service.retryProcessing(f.user,f.library,f.id,failed.attempt)).status,"chunked");
    await new EmbeddingProcessor(f.pool,f.client).processNext(f.id);
    assert.equal((await f.service.processing(f.user,f.library,f.id)).status,"embedded");
    assert.deepEqual((await f.pool.query("SELECT id FROM public.knowledge_document_chunks WHERE document_id=$1 ORDER BY ordinal",[f.id])).rows,chunks);
  }finally{await f.close();}
});
test("真实 PostgreSQL：过期嵌入轮次明确中断，重试后旧结果无权提交",async()=>{
  const f=await fixture();try{
    const worker=new EmbeddingProcessor(f.pool,f.client),old=await worker.claim(f.id);assert.ok(old);
    await f.pool.query("UPDATE public.knowledge_documents SET processing_lease_expires_at=now()-interval '1 second' WHERE id=$1",[f.id]);
    assert.equal(await worker.heartbeat(old),false);await worker.recoverInterrupted(f.id);
    const state=await f.service.processing(f.user,f.library,f.id);assert.match(state.error!,/中断/);
    await f.service.retryProcessing(f.user,f.library,f.id,state.attempt);await worker.processNext(f.id);
    const chunks=(await f.pool.query<{id:string;text:string}>("SELECT id,text FROM public.knowledge_document_chunks WHERE document_id=$1 ORDER BY ordinal",[f.id])).rows;
    assert.equal(await worker.finish(old,chunks,chunks.map(()=>[4,5,6])),false);
    assert.ok((await f.pool.query("SELECT embedding FROM public.knowledge_document_chunks WHERE document_id=$1",[f.id])).rows.every(row=>JSON.stringify(row.embedding)==="[1,2,3]"));
  }finally{await f.close();}
});
test("真实 PostgreSQL：嵌入请求被取消后不能保存迟到的向量",async()=>{
  const f=await fixture();try{
    const slow:EmbeddingClient={...f.client,embedDocuments:async(_texts,signal)=>await new Promise((_resolve,reject)=>{signal!.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true});})};
    await new EmbeddingProcessor(f.pool,slow,30).processNext(f.id);
    assert.equal((await f.service.processing(f.user,f.library,f.id)).status,"failed");
    assert.equal((await f.pool.query("SELECT id FROM public.knowledge_document_chunks WHERE document_id=$1 AND embedding IS NOT NULL",[f.id])).rowCount,0);
  }finally{await f.close();}
});
