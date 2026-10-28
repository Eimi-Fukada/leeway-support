import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/database.ts";
import { DocumentService } from "../src/documents/service.ts";
import { DocumentProcessor } from "../src/documents/processor.ts";
import { LocalDocumentStorage } from "../src/documents/storage.ts";
import { createEmbeddingClient } from "../src/embeddings/client.ts";
import { EmbeddingProcessor } from "../src/embeddings/processor.ts";
import { QdrantStore,readQdrantConfig,QdrantError,type VectorPoint,type IndexTarget } from "../src/indexing/qdrant.ts";
import { IndexProcessor } from "../src/indexing/processor.ts";
process.loadEnvFile(fileURLToPath(new URL("../.env",import.meta.url)));
async function fixture(){
 const pool=createPool(),root=await mkdtemp(join(tmpdir(),"qdrant-pg-")),user=randomUUID(),library=randomUUID();
 await pool.query("INSERT INTO public.knowledge_users(id,username,password_hash) VALUES($1,$2,'unused')",[user,`qdrant-${user}`]);
 await pool.query("INSERT INTO public.knowledge_bases(id,owner_id,name) VALUES($1,$2,'向量写入测试')",[library,user]);
 const storage=new LocalDocumentStorage(root),service=new DocumentService(pool,storage);
 const id=(await service.upload(user,library,"索引.md",Buffer.from("# 退款\n七天内可申请，但续费属于例外。\n\n# 权限\n仅授权管理员可以提交。"))).document.id;
 await new DocumentProcessor(pool,storage).processNext(id);
 const embed=createEmbeddingClient({provider:"ollama",baseUrl:"http://127.0.0.1:11434",model:"qdrant-test",revision:"1",dimensions:3,batchSize:8,timeoutMs:1000,documentPrefix:"",queryPrefix:""},async(_url,init)=>Response.json({model:"qdrant-test",embeddings:JSON.parse(String(init!.body)).input.map(()=>[1,2,3])}));
 await new EmbeddingProcessor(pool,embed).processNext(id);
 const config={...readQdrantConfig(),collectionPrefix:`test_${user.replaceAll("-","")}`,batchSize:1};
 const store=new QdrantStore(config),worker=new IndexProcessor(pool,store),collection=store.collection(embed.profile.id);
 return{pool,user,library,id,service,store,worker,collection,close:async()=>{
   try{await store.request("DELETE",`/collections/${collection}`);}catch(error){if(!(error instanceof QdrantError)||error.status!==404)throw error;}
   finally{await pool.query("DELETE FROM public.knowledge_documents WHERE knowledge_base_id=$1",[library]);await pool.query("DELETE FROM public.knowledge_bases WHERE id=$1",[library]);await pool.query("DELETE FROM public.knowledge_users WHERE id=$1",[user]);await pool.end();await rm(root,{recursive:true,force:true});}
 }};
}
test("真实 PostgreSQL＋Qdrant：稳定片段写入、逐项读回、五步完成、回执及重复执行不增加记录",async()=>{
 const f=await fixture();try{
  const runs=await Promise.all([f.worker.processNext(f.id),f.worker.processNext(f.id)]);assert.equal(runs.filter(Boolean).length,1);
  const state=await f.service.processing(f.user,f.library,f.id);assert.equal(state.status,"ready");assert.ok(state.steps.every(step=>step.status==="completed"));assert.equal(state.index!.collection,f.collection);
  const points=await f.store.request("POST",`/collections/${f.collection}/points/scroll`,{limit:10,with_payload:true,with_vector:true,filter:{must:[{key:"document_id",match:{value:f.id}}]}});
  assert.equal(points.points.length,2);for(const point of points.points){assert.equal(point.payload.knowledge_base_id,f.library);assert.equal(point.payload.generation_id,state.index!.generationId);assert.equal(point.vector.length,3);assert.ok(point.payload.text);}
  assert.equal(await f.worker.processNext(f.id),false);
  assert.equal((await f.store.request("POST",`/collections/${f.collection}/points/count`,{exact:true})).count,2);
 }finally{await f.close();}
});
test("真实 Qdrant 已写入但回执丢失：保留未知，拒绝盲重试，独立只读核对可恢复 ready",async()=>{
 const f=await fixture();try{
  class LostReceipt extends QdrantStore{override async upsert(collection:string,points:VectorPoint[],signal?:AbortSignal){await super.upsert(collection,points,signal);throw new QdrantError(true,"timeout after actual write");}}
  // 两片段在同一批写入，模拟完整成功后网络丢失。
  await new IndexProcessor(f.pool,new LostReceipt({...f.store.config,batchSize:8})).processNext(f.id);
  const unknown=await f.service.processing(f.user,f.library,f.id);assert.equal(unknown.status,"failed");assert.equal(unknown.canRetry,false);assert.equal(unknown.canReconcile,true);
  await assert.rejects(f.service.retryProcessing(f.user,f.library,f.id,unknown.attempt),/状态已变化/);
  await f.worker.reconcile(f.id,unknown.attempt);assert.equal((await f.service.processing(f.user,f.library,f.id)).status,"ready");
 }finally{await f.close();}
});
test("真实 Qdrant 部分写入：核对不写向量，确认缺失后显式重试沿相同 ID 完成，无重复点",async()=>{
 const f=await fixture();try{
  class Partial extends QdrantStore{calls=0;override async upsert(collection:string,points:VectorPoint[],signal?:AbortSignal){if(++this.calls===2)throw new QdrantError(true,"connection lost");await super.upsert(collection,points,signal);}}
  await new IndexProcessor(f.pool,new Partial(f.store.config)).processNext(f.id);
  const unknown=await f.service.processing(f.user,f.library,f.id);assert.equal(unknown.canRetry,false);
  const before=(await f.store.request("POST",`/collections/${f.collection}/points/count`,{exact:true})).count;assert.equal(before,1);
  await f.worker.reconcile(f.id,unknown.attempt);
  const checked=await f.service.processing(f.user,f.library,f.id);assert.equal(checked.status,"failed");assert.equal(checked.canRetry,true);
  assert.equal((await f.store.request("POST",`/collections/${f.collection}/points/count`,{exact:true})).count,before);
  await f.service.retryProcessing(f.user,f.library,f.id,checked.attempt);await f.worker.processNext(f.id);
  assert.equal((await f.service.processing(f.user,f.library,f.id)).status,"ready");assert.equal((await f.store.request("POST",`/collections/${f.collection}/points/count`,{exact:true})).count,2);
 }finally{await f.close();}
});
test("真实 Qdrant：错误正文/来源不冒充完成，错误索引目标不被重新定向写入",async()=>{
 const f=await fixture();try{
  await f.worker.processNext(f.id);const state=await f.service.processing(f.user,f.library,f.id);
  const point=(await f.store.request("POST",`/collections/${f.collection}/points/scroll`,{limit:1,with_payload:true})).points[0];
  await f.store.request("POST",`/collections/${f.collection}/points/payload?wait=true`,{points:[point.id],payload:{text:"被篡改的正文"}});
  await f.pool.query("UPDATE public.knowledge_documents SET processing_status='failed',processing_failed_stage='indexing',processing_error_code='result_unknown' WHERE id=$1",[f.id]);
  await f.worker.reconcile(f.id,state.attempt);assert.equal((await f.service.processing(f.user,f.library,f.id)).status,"failed");
  const target=(await f.pool.query<{index_target:IndexTarget}>("SELECT index_target FROM public.knowledge_documents WHERE id=$1",[f.id])).rows[0]!.index_target;
  await f.pool.query("UPDATE public.knowledge_documents SET index_target=$2 WHERE id=$1",[f.id,JSON.stringify({...target,endpointHash:"wrong-endpoint"})]);
  const failed=await f.service.processing(f.user,f.library,f.id);await f.service.retryProcessing(f.user,f.library,f.id,failed.attempt);await f.worker.processNext(f.id);
  assert.equal((await f.service.processing(f.user,f.library,f.id)).status,"failed");
 }finally{await f.close();}
});
test("真实 PostgreSQL：过期索引任务只标记未知，不自动补写或伪造 ready",async()=>{
 const f=await fixture();try{
  const run=await f.worker.claim(f.id);assert.ok(run);
  await f.pool.query("UPDATE public.knowledge_documents SET processing_lease_expires_at=now()-interval '1 second' WHERE id=$1",[f.id]);
  await f.worker.recoverInterrupted(f.id);const state=await f.service.processing(f.user,f.library,f.id);assert.equal(state.status,"failed");assert.equal(state.canRetry,false);assert.equal(state.index,null);
  assert.equal(await f.worker.processNext(f.id),false);
  assert.equal(state.canReconcile,true);await f.worker.reconcile(f.id,state.attempt);
  const checked=await f.service.processing(f.user,f.library,f.id);assert.equal(checked.canRetry,true);
  await f.service.retryProcessing(f.user,f.library,f.id,checked.attempt);await f.worker.processNext(f.id);
  assert.equal((await f.service.processing(f.user,f.library,f.id)).status,"ready");
 }finally{await f.close();}
});
