import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { RetrievalService } from "../src/retrieval/service.ts";
import { createEmbeddingClient } from "../src/embeddings/client.ts";
import { QdrantStore, hash } from "../src/indexing/qdrant.ts";

const baseId="00000000-0000-4000-8000-000000000001", docId="00000000-0000-4000-8000-000000000002",chunkId="00000000-0000-4000-8000-000000000003";
function fixture(mode="ok") {
 let modelCalls=0, searches=0, audits=0;
 const embedding=createEmbeddingClient({provider:"ollama",baseUrl:"http://local",model:"test",revision:"1",dimensions:3,timeoutMs:1000,batchSize:1,documentPrefix:"",queryPrefix:"query: "},async()=>{modelCalls++;return Response.json({model:"test",embeddings:[[1,2,3]]});});
 const store=new QdrantStore({baseUrl:"http://qdrant",collectionPrefix:"test",timeoutMs:1000,batchSize:1},async(_url,init)=>{
  searches++;const body=JSON.parse(String(init?.body));assert.equal(body.with_vector,false);
  assert.ok(JSON.stringify(body.filter).includes(baseId));assert.ok(JSON.stringify(body.filter).includes("generation-1"));
  if(mode==="network")throw new Error("private secret");
  return Response.json({status:"ok",result:{points:mode==="no_match"?[]:[{id:chunkId,score:0.8,payload:{document_id:docId,knowledge_base_id:baseId,
    generation_id:"generation-1",source_sha256:"source",embedding_profile_id:embedding.profile.id,chunk_sha256:hash("原文证据"),text:mode==="corrupt"?"被篡改":"原文证据"}}]}});
 });
 const receipt={collection:store.collection(embedding.profile.id),profileId:embedding.profile.id,endpointHash:store.endpointHash,generationId:"generation-1",manifestHash:"manifest",verifiedAt:"today"};
 const source={id:docId,name:"制度",sha256:"source",embedding_profile:embedding.profile,index_receipt:receipt,index_target:receipt};
 const pool={query:async(sql:string)=>{
  if(sql.startsWith("SELECT id FROM public.knowledge_bases"))return {rowCount:mode==="forbidden"?0:1};
  if(sql.includes("FROM public.knowledge_documents"))return {rows:mode==="empty"?[]:[mode==="profile"?{...source,embedding_profile:{id:"wrong"}}:source]};
  if(sql.includes("FROM public.knowledge_document_chunks"))return {rows:[{id:chunkId,document_id:docId,text:"原文证据",content_sha256:hash("原文证据"),heading_path:["时限"],section_index:0,start_offset:0,end_offset:4}]};
  if(sql.startsWith("INSERT INTO")){audits++;return {rows:[]};}throw new Error(sql);
 }} as unknown as pg.Pool;
 return {service:new RetrievalService(pool,embedding,store),counts:()=>({modelCalls,searches,audits})};
}
test("查询在授权范围内召回并返回 PostgreSQL 正文和可追溯来源，不保存问题向量",async()=>{
 const f=fixture();const r=await f.service.search("user",baseId,{question:"什么时候？"});assert.equal(r.status,"ok");assert.equal(r.evidence[0]?.text,"原文证据");assert.equal(r.evidence[0]?.generationId,"generation-1");assert.deepEqual(f.counts(),{modelCalls:1,searches:1,audits:1});
});
test("无可用资料与查询成功无匹配分开，空库不调用模型",async()=>{
 const f=fixture("empty");assert.equal((await f.service.search("user",baseId,{question:"问题"})).status,"no_ready_documents");assert.equal(f.counts().modelCalls,0);
 assert.equal((await fixture("no_match").service.search("user",baseId,{question:"问题"})).status,"no_match");
});
test("越权、配置冲突、注入范围、空问题在依赖调用前拒绝",async()=>{
 for(const mode of ["forbidden","profile"]){const f=fixture(mode);await assert.rejects(f.service.search("user",baseId,{question:"问题"}));assert.equal(f.counts().modelCalls,0);}
 const f=fixture();for(const input of [{question:" "},{question:"问题",collection:"other"}])await assert.rejects(f.service.search("user",baseId,input));assert.equal(f.counts().modelCalls,0);
});
test("依赖失败和来源损坏不冒充没有资料",async()=>{
 for(const mode of ["network","corrupt"]){const f=fixture(mode);await assert.rejects(f.service.search("user",baseId,{question:"问题"}));assert.equal(f.counts().audits,1);}
});
