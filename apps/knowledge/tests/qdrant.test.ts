import test from "node:test";
import assert from "node:assert/strict";
import { QdrantStore,QdrantError,readQdrantConfig,hash,type VectorPoint } from "../src/indexing/qdrant.ts";
import type { EmbeddingProfile } from "../src/embeddings/client.ts";
const config={baseUrl:"http://127.0.0.1:6333",collectionPrefix:"test",timeoutMs:1000,batchSize:8};
const profile:EmbeddingProfile={id:hash("test-profile"),provider:"ollama",endpointHash:hash("embed"),model:"test",revision:"1",dimensions:3,documentPrefix:"",queryPrefix:""};
const point:VectorPoint={id:"00000000-0000-4000-8000-000000000001",vector:[1,2,3],payload:{document_id:"A",generation_id:"current",text:"原文",heading_path:["规则"]}};
test("Qdrant 配置限制 URL/路径/名称/超时，集合按完整嵌入配置隔离",()=>{
 const store=new QdrantStore(readQdrantConfig({QDRANT_URL:config.baseUrl}));assert.ok(store.collection(profile.id).endsWith(profile.id));
 for(const env of [{QDRANT_URL:"http://user:password@host"},{QDRANT_URL:"http://host/collections"},{QDRANT_URL:config.baseUrl,QDRANT_COLLECTION_PREFIX:"../bad"},{QDRANT_URL:config.baseUrl,QDRANT_BATCH_SIZE:"0"}])assert.throws(()=>readQdrantConfig(env));
});
test("集合存在时校验维度/距离，建立过滤索引，不静默重建不兼容集合",async()=>{
 let puts=0;const store=new QdrantStore(config,async(_url,init)=>{if(init!.method==="GET")return Response.json({status:"ok",result:{config:{params:{vectors:{size:3,distance:"Cosine"}}}}});puts++;return Response.json({status:"ok",result:{status:"completed"}});});
 await store.ensureCollection(profile);assert.equal(puts,4);
 const wrong=new QdrantStore(config,async()=>Response.json({status:"ok",result:{config:{params:{vectors:{size:4,distance:"Cosine"}}}}}));
 await assert.rejects(wrong.ensureCollection(profile),/不匹配/);
});
test("写入要求 wait=true 和 completed，acknowledged 不能直接发布成功",async()=>{
 const store=new QdrantStore(config,async(url,init)=>{assert.ok(String(url).endsWith("/points?wait=true"));assert.equal(init!.method,"PUT");return Response.json({status:"ok",result:{status:"acknowledged"}});});
 await assert.rejects(store.upsert("collection",[point]),error=>error instanceof QdrantError&&error.uncertain);
});
test("读回确认必须匹配每个 ID、来源正文和向量；不能靠总数量判断",async()=>{
 const norm=Math.sqrt(14);const result={...point,vector:point.vector.map(value=>value/norm)};
 const make=(points:unknown[])=>new QdrantStore(config,async()=>Response.json({status:"ok",result:points}));
 assert.equal(await make([result]).verify("collection",[point],3),true);
 assert.equal(await make([]).verify("collection",[point],3),false);
 assert.equal(await make([{...result,id:"other"}]).verify("collection",[point],3),false);
 assert.equal(await make([{...result,payload:{...point.payload,generation_id:"old"}}]).verify("collection",[point],3),false);
 assert.equal(await make([{...result,vector:[0,1,0]}]).verify("collection",[point],3),false);
});
test("网络异常与服务错误只返回安全说明，并区分不确定与明确拒绝",async()=>{
 await assert.rejects(new QdrantStore(config,async()=>{throw new Error("api-key secret");}).upsert("collection",[point]),error=>error instanceof QdrantError&&error.uncertain&&!error.message.includes("secret"));
 await assert.rejects(new QdrantStore(config,async()=>new Response("secret",{status:400})).upsert("collection",[point]),error=>error instanceof QdrantError&&!error.uncertain&&!error.message.includes("secret"));
});
