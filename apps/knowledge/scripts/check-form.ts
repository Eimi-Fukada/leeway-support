import assert from "node:assert/strict";
import { createHash,randomBytes,randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/database.ts";
process.loadEnvFile(fileURLToPath(new URL("../.env",import.meta.url)));
const pool=createPool(),token=randomBytes(32).toString("hex"),digest=createHash("sha256").update(token).digest("hex"),baseId="353b8542-32a0-4247-a5d4-4b367b5cc19d",threadId=`eval-form-${randomUUID()}`;
try{
 const user=(await pool.query("SELECT owner_id FROM public.knowledge_bases WHERE id=$1",[baseId])).rows[0].owner_id;
 await pool.query("INSERT INTO public.knowledge_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')",[digest,user]);
 const endpoint=`http://127.0.0.1:3200/api/knowledge-bases/${baseId}/chat`,headers={"Content-Type":"application/json",Origin:"http://127.0.0.1:3200",Cookie:`leeway_knowledge_session=${token}`};
 async function run(payload:Record<string,unknown>){
  const response=await fetch(endpoint,{method:"POST",headers,body:JSON.stringify({threadId,...payload}),signal:AbortSignal.timeout(200000)});assert.equal(response.status,200);
  const events=(await response.text()).split("\n\n").filter(x=>x.startsWith("data: ")).map(x=>JSON.parse(x.slice(6)));
  assert.ok(!events.some(e=>e.type==="RUN_ERROR"),"真实表单轮次不能失败");const result=events.find(e=>e.type==="CUSTOM"&&e.name==="support.result")?.value;assert.ok(result);return result;
 }
 const first=await run({requestId:randomUUID(),message:"先查询青禾首次购买月付版退款规则，然后单独调用 request_information 表单问我订单是不是首次购买；本轮不要回答退款结论，等我填写后再继续。",options:{webSearch:false,thinkingMode:"quick"}});
 assert.equal(first.status,"waiting_for_input");assert.ok(first.details.citations.length>0,"暂停前应已取得来源");
 const form=first.information,submissionId=randomUUID(),answers:Record<string,string>={};
 for(const field of form.spec.fields)answers[field.key]=field.type==="select"?field.options[0].value:"是，首次购买，昨天购买，使用半小时";
 const payload={requestId:submissionId,message:"提交补充信息",options:{webSearch:true,thinkingMode:"deep"},submission:{formId:form.formId,formVersion:1,interruptId:form.interruptId,submissionId,answers}};
 const completed=await run(payload);assert.equal(completed.status,"completed");assert.deepEqual(completed.details.options,{webSearch:false,thinkingMode:"quick"});assert.ok(completed.details.citations.length>0);
 assert.deepEqual(await run(payload),completed);
 const second=await run({requestId:randomUUID(),message:"另一个独立问题：请单独用 request_information 表单询问我现在使用的操作系统，再等待我填写。",options:{webSearch:false,thinkingMode:"deep"}});
 assert.equal(second.status,"waiting_for_input");assert.deepEqual(await run(payload),completed,"第二个表单等待中仍能幂等重放已完成的第一个恢复请求");
 console.log(JSON.stringify({threadId,first:"waiting_for_input",firstSources:first.details.citations.length,resumed:"completed",retainedSources:completed.details.citations.length,frozenOptions:completed.details.options,oldSubmissionReplayDuringNewPause:true}));
}finally{await pool.query("DELETE FROM public.knowledge_sessions WHERE token_hash=$1",[digest]);await pool.end();}
