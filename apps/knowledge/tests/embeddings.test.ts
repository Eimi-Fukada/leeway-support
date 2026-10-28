import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createEmbeddingClient,readEmbeddingConfig,validateVectors,type EmbeddingConfig } from "../src/embeddings/client.ts";

const base:EmbeddingConfig={provider:"ollama",baseUrl:"http://127.0.0.1:11434",model:"local-embed",revision:"test-v1",dimensions:3,timeoutMs:1000,batchSize:2,documentPrefix:"",queryPrefix:"query: "};
test("嵌入环境配置独立于聊天模型，校验地址/提供方/整数/密钥，不回显配置值",()=>{
  const env={EMBEDDING_PROVIDER:"ollama",EMBEDDING_BASE_URL:base.baseUrl,EMBEDDING_MODEL:base.model,EMBEDDING_MODEL_REVISION:"v1",EMBEDDING_DIMENSIONS:"3"};
  assert.equal(readEmbeddingConfig(env).model,"local-embed");
  for(const override of [{EMBEDDING_PROVIDER:"bad"},{EMBEDDING_BASE_URL:"http://secret:password@host"},{EMBEDDING_BASE_URL:"http://host/api/embed"},{EMBEDDING_DIMENSIONS:"0"},{EMBEDDING_BATCH_SIZE:"1.5"},{EMBEDDING_TIMEOUT_MS:"NaN"},{EMBEDDING_PROVIDER:"openai-compatible"}]){
    assert.throws(()=>readEmbeddingConfig({...env,...override}),error=>error instanceof Error && !error.message.includes("password") && /配置无效/.test(error.message));
  }
  assert.equal(readEmbeddingConfig({...env,EMBEDDING_QUERY_PREFIX:"Instruct: retrieve\\nQuery: "}).queryPrefix,"Instruct: retrieve\nQuery: ");
});
test("Ollama 请求携带模型/批次/禁止截断，查询和文档前缀分别应用，密钥不进入 profile",async()=>{
  const requests:Array<{url:string;body:Record<string,unknown>}> = [];
  const fake:typeof fetch=async(url,init)=>{requests.push({url:String(url),body:JSON.parse(String(init!.body))});return Response.json({model:base.model,embeddings:[[1,2,3]]});};
  const client=createEmbeddingClient({...base,apiKey:"secret-api-key"},fake);
  assert.deepEqual(await client.embedDocuments(["正文"]),[[1,2,3]]);
  assert.deepEqual(await client.embedQuery("问题"),[1,2,3]);
  assert.equal(requests[0]!.url,base.baseUrl+"/api/embed");assert.equal(requests[0]!.body.truncate,false);
  assert.deepEqual(requests[0]!.body.input,["正文"]);assert.deepEqual(requests[1]!.body.input,["query: 问题"]);
  assert.ok(!JSON.stringify(client.profile).includes("secret"));
  assert.equal(client.profile.id,createEmbeddingClient({...base,apiKey:"other"},fake).profile.id);
  assert.notEqual(client.profile.id,createEmbeddingClient({...base,revision:"v2"},fake).profile.id);
});
test("OpenAI 兼容适配器按 index 恢复原顺序，使用相同客户端契约",async()=>{
  const fake:typeof fetch=async(url,init)=>{
    assert.equal(String(url),"https://cloud.invalid/v1/embeddings");
    assert.equal((init!.headers as Record<string,string>).Authorization,"Bearer test-key");
    const body=JSON.parse(String(init!.body));assert.equal(body.encoding_format,"float");assert.ok(!("truncate" in body));
    return Response.json({data:[{index:1,embedding:[4,5,6]},{index:0,embedding:[1,2,3]}]});
  };
  assert.deepEqual(await createEmbeddingClient({...base,provider:"openai-compatible",baseUrl:"https://cloud.invalid/v1",apiKey:"test-key"},fake).embedDocuments(["A","B"]),[[1,2,3],[4,5,6]]);
});
test("拒绝数量/维度/非有限数/零向量、模型错配、重复响应索引和异常响应体",async()=>{
  for(const vectors of [[],[[1,2]],[[0,0,0]],[[1,NaN,3]],[[1,Infinity,3]]]) assert.throws(()=>validateVectors(vectors,1,3));
  for(const body of [{model:"wrong",embeddings:[[1,2,3]]},{model:base.model,embeddings:[[1,2]]},{model:base.model,embeddings:[[0,0,0]]}]){
    await assert.rejects(createEmbeddingClient(base,async()=>Response.json(body)).embedDocuments(["正文"]));
  }
  await assert.rejects(createEmbeddingClient(base,async()=>new Response("x".repeat(70000))).embedDocuments(["正文"]),/大小限制/);
  await assert.rejects(createEmbeddingClient({...base,provider:"openai-compatible"},async()=>Response.json({data:[{index:0,embedding:[1,2,3]},{index:0,embedding:[4,5,6]}]})).embedDocuments(["A","B"]),/序号无效/);
});
test("HTTP 失败与底层异常不回显凭据/正文，不自动重试，已取消的调用不发请求",async()=>{
  let calls=0;
  const fake:typeof fetch=async()=>{calls++;return new Response("secret-key private document",{status:503});};
  await assert.rejects(createEmbeddingClient(base,fake).embedDocuments(["private document"]),error=>error instanceof Error && /HTTP 503/.test(error.message) && !/secret|private/.test(error.message));
  assert.equal(calls,1);
  await assert.rejects(createEmbeddingClient(base,async()=>{throw new Error("secret-key");}).embedDocuments(["text"]),/暂不可用/);
  const controller=new AbortController();controller.abort();await assert.rejects(createEmbeddingClient(base,fake).embedDocuments(["text"],controller.signal),/取消|超时/);assert.equal(calls,1);
});
test("真实 HTTP 传输：嵌入请求超时会中止，不永久占用 worker",async()=>{
  const server=createServer((_request,_response)=>{});server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    const address=server.address();assert.ok(address && typeof address!=="string");
    await assert.rejects(createEmbeddingClient({...base,baseUrl:`http://127.0.0.1:${address.port}`,timeoutMs:30}).embedDocuments(["test"]),/取消|超时/);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
