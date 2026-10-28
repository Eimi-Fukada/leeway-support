import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID,randomBytes,createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/database.ts";
import { KnowledgeService } from "../src/service.ts";
import { signedHeaders,secret } from "../src/integrations/signature.ts";
process.loadEnvFile(fileURLToPath(new URL("../.env",import.meta.url)));
test("真实 HTTP＋PostgreSQL：双向签名、重放、伪造主体、应用撤权和登出均受控",async()=>{
 const pool=createPool(),user=randomUUID(),token=randomBytes(32).toString("hex"),sessionHash=createHash("sha256").update(token).digest("hex");
 let baseId:string|undefined;
 try{
  await pool.query("INSERT INTO public.knowledge_users(id,username,password_hash) VALUES($1,$2,'unused')",[user,`auth-${user}`]);
  await pool.query("INSERT INTO public.knowledge_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')",[sessionHash,user]);
  baseId=(await new KnowledgeService(pool).create(user,{name:"服务认证测试"})).id;
  const path="/api/internal/knowledge",value={operation:"scope",userId:user,sessionHash,baseId,applicationId:"knowledge-chat"},body=JSON.stringify(value),key=secret("KNOWLEDGE_SUPPORT_AGENT_SECRET");
  const headers=signedHeaders("support-agent","knowledge",path,body,key),url=`http://127.0.0.1:3200${path}`;
  const send=(text:string,head:Record<string,string>)=>fetch(url,{method:"POST",headers:head,body:text});
  const valid=await send(body,headers);assert.equal(valid.status,200);assert.equal(typeof (await valid.json()).revision,"string");
  assert.equal((await send(body,headers)).status,401);
  assert.equal((await send(body+" ",signedHeaders("support-agent","knowledge",path,body,key))).status,401);
  assert.equal((await send(body,signedHeaders("support-agent","other",path,body,key))).status,401);
  const forged=JSON.stringify({...value,userId:randomUUID()});assert.equal((await send(forged,signedHeaders("support-agent","knowledge",path,forged,key))).status,403);
  await pool.query("UPDATE public.knowledge_application_grants SET active=false WHERE knowledge_base_id=$1",[baseId]);
  assert.equal((await send(body,signedHeaders("support-agent","knowledge",path,body,key))).status,403);
  await pool.query("UPDATE public.knowledge_application_grants SET active=true WHERE knowledge_base_id=$1",[baseId]);
  const agentPath="/api/internal/knowledge-chat",historyBody=JSON.stringify({...value,operation:"history",threadId:randomUUID()});
  const history=await fetch(`http://127.0.0.1:3100${agentPath}`,{method:"POST",headers:signedHeaders("knowledge-web","agent",agentPath,historyBody,secret("AGENT_KNOWLEDGE_WEB_SECRET")),body:historyBody});
  assert.equal(history.status,200);assert.equal((await history.json()).snapshot.status,"empty");
  const mismatched=JSON.stringify({...value,operation:"run",threadId:randomUUID(),requestId:"other-request",message:"提交",options:{webSearch:true,thinkingMode:"deep"},submission:{formId:randomUUID(),formVersion:1,interruptId:"test",submissionId:randomUUID(),answers:{}}});
  const rejected=await fetch(`http://127.0.0.1:3100${agentPath}`,{method:"POST",headers:signedHeaders("knowledge-web","agent",agentPath,mismatched,secret("AGENT_KNOWLEDGE_WEB_SECRET")),body:mismatched});assert.equal(rejected.status,400);
  await pool.query("DELETE FROM public.knowledge_sessions WHERE token_hash=$1",[sessionHash]);
  assert.equal((await send(body,signedHeaders("support-agent","knowledge",path,body,key))).status,403);
 }finally{
  await pool.query("DELETE FROM public.knowledge_sessions WHERE user_id=$1",[user]);
  if(baseId)await pool.query("DELETE FROM public.knowledge_bases WHERE id=$1",[baseId]);
  await pool.query("DELETE FROM public.knowledge_users WHERE id=$1",[user]);await pool.end();
 }
});
