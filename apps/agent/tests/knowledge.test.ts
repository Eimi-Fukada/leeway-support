import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage,fakeModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { createSupportAgent } from "../src/agent/agent.ts";
import { runSupportAgent } from "../src/agent/run.ts";
import { TestInformationBackend } from "./fixtures/information-backend.ts";
import { TestConversationBackend } from "./fixtures/conversation-backend.ts";
import { localSupportContext,memoryScope,checkpointThreadId } from "../src/support-context.ts";
import { withCapabilities,runOptionsSchema,currentCapabilities,collectProviderContent,type RunDetails } from "../src/knowledge/runtime.ts";
import type { KnowledgeClient } from "../src/knowledge/client.ts";
import { requestHash,conversationSnapshot } from "../src/conversations/execution.ts";
import { signedHeaders,verifyService } from "../src/integrations/signature.ts";
import type pg from "pg";

const client={scope:async()=>"revision"} as KnowledgeClient;
const details=():RunDetails=>({model:"test",options:{webSearch:false,thinkingMode:"quick"},citations:[],searchCalls:0});
test("选项默认值与请求幂等键包含实际执行选项",()=>{
 assert.deepEqual(runOptionsSchema.parse({}),{webSearch:false,thinkingMode:"quick"});
 assert.notEqual(requestHash("问题",undefined,{webSearch:false}),requestHash("问题",undefined,{webSearch:true}));
 assert.throws(()=>runOptionsSchema.parse({thinkingMode:"fake"}));
});
test("服务签名绑定 audience、路径、原始正文、时间与一次性 nonce",async()=>{
 const seen=new Set<string>();const pool={query:async(sql:string,args:string[])=>{if(sql.startsWith("DELETE"))return {};const key=args[1]!;if(seen.has(key))return {rowCount:0};seen.add(key);return {rowCount:1};}} as unknown as pg.Pool;
 const key="x".repeat(64),body='{"message":"问题"}',path="/api/internal/knowledge-chat",headers=signedHeaders("knowledge-web","agent",path,body,key);
 const request=new Request(`http://local${path}`,{method:"POST",headers,body});
 await verifyService(request,body,key,pool,"support_service_nonces","knowledge-web","agent");
 await assert.rejects(verifyService(request,body,key,pool,"support_service_nonces","knowledge-web","agent"),/已使用/);
 for(const [url,text,aud] of [[`http://local/other`,body,"agent"],[`http://local${path}`,body+" ","agent"],[`http://local${path}`,body,"other"]])await assert.rejects(verifyService(new Request(url!,{method:"POST",headers,body}),text!,key,pool,"support_service_nonces","knowledge-web",aud!));
});
test("并发运行能力隔离；网页引用只接受真实 annotations 中的安全 URL",async()=>{
 await Promise.all([false,true].map(webSearch=>withCapabilities({client,revision:"revision",details:{...details(),options:{webSearch,thinkingMode:"quick"}}},async()=>{
  await Promise.resolve();assert.equal(currentCapabilities()?.details.options.webSearch,webSearch);
  collectProviderContent([{type:"text",annotations:[{type:"url_citation",url:"javascript:alert(1)"},{type:"citation",source:"url_citation",url:"https://example.com",title:"来源"}]}]);
  assert.equal(currentCapabilities()?.details.citations.length,1);
 })));
 assert.equal(currentCapabilities(),undefined);
});
test("没有授权清单的模型引用不能获得完成回执",async()=>{
 const model=fakeModel().respond(new AIMessage("答案 [K:invented]"));const forms=new TestInformationBackend(),journal=new TestConversationBackend();
 const agent=createSupportAgent(model,new MemorySaver(),{},{},undefined,forms);
 await assert.rejects(withCapabilities({client,revision:"revision",details:details()},()=>runSupportAgent(agent,"问题",undefined,"bad-citation",localSupportContext("test"),{service:forms,conversation:journal,requestId:"one"})),/未核对/);
});
test("历史网页引用编号不连续时，新网页不会覆盖或复用旧编号",async()=>{
 const d=details();d.citations=[{id:"W:3",kind:"web",title:"旧来源",url:"https://old.example"},{id:"W:9",kind:"web",title:"旧来源2",url:"https://older.example"}];
 await withCapabilities({client,revision:"revision",details:d},async()=>{
  collectProviderContent([{type:"text",annotations:[{type:"url_citation",url:"https://new.example",title:"新来源"}]}]);
  assert.equal(new Set(d.citations.map(c=>c.id)).size,d.citations.length);assert.equal(d.citations[0]?.url,"https://old.example");
 });
});
test("原生搜索请求在首个文本前 503 也不自动重试",async()=>{
 const model=fakeModel().respond(()=>{throw Object.assign(new Error("provider failed"),{status:503});});
 const agent=createSupportAgent(model);const d=details();d.options.webSearch=true;
 await assert.rejects(withCapabilities({client,revision:"revision",details:d},()=>runSupportAgent(agent,"问题")));
 assert.equal(model.calls.length,1);
});
test("补资料暂停保存证据，恢复使用原证据清单，完成与幂等回放均保留引用",async()=>{
 const spec={title:"补充资料",description:"请补充情况",fields:[{key:"issue",label:"问题",type:"text",required:true}]};
 const model=fakeModel().respond(new AIMessage({content:"",tool_calls:[{id:"form",name:"request_information",args:spec}]})).respond(new AIMessage("依据原文处理。[K:source]"));
 const forms=new TestInformationBackend(),journal=new TestConversationBackend(),agent=createSupportAgent(model,new MemorySaver(),{},{},undefined,forms),context=localSupportContext("resume-evidence");
 const d=details();d.citations=[{id:"K:source",kind:"knowledge",title:"已核对原文"}];
 const waiting=await withCapabilities({client,revision:"revision",details:d},()=>runSupportAgent(agent,"问题",undefined,"resume",context,{service:forms,conversation:journal,requestId:"root"}));
 assert.equal(waiting.status,"waiting_for_input");assert.equal(waiting.details?.citations.length,1);
 const form=waiting.information!;const submission={formId:form.formId,formVersion:1 as const,submissionId:"11111111-1111-4111-8111-111111111111",interruptId:form.interruptId!,answers:{issue:"补充说明"}};
 const invoke=()=>withCapabilities({client,revision:"revision",details:structuredClone(waiting.details!)},()=>runSupportAgent(agent,"提交资料",undefined,"resume",context,{service:forms,conversation:journal,requestId:submission.submissionId,submission}));
 const completed=await invoke();assert.equal(completed.details?.citations[0]?.id,"K:source");assert.deepEqual(await invoke(),completed);assert.equal(model.calls.length,2);
});
test("最终发布前范围变化不会写入成功回执",async()=>{
 const changed={scope:async()=>"changed"} as KnowledgeClient,forms=new TestInformationBackend(),journal=new TestConversationBackend();
 const agent=createSupportAgent(fakeModel().respond(new AIMessage("答案")),new MemorySaver(),{},{},undefined,forms);
 await assert.rejects(withCapabilities({client:changed,revision:"revision",details:details()},()=>runSupportAgent(agent,"问题",undefined,"changed",localSupportContext("changed"),{service:forms,conversation:journal,requestId:"one"})),/失效/);
});
test("完成档案提交中断后，核对回执恢复两类引用和选项，零模型重跑",async()=>{
 const model=fakeModel().respond(new AIMessage("答案 [K:source]")),forms=new TestInformationBackend(),journal=new TestConversationBackend();
 const agent=createSupportAgent(model,new MemorySaver(),{},{},undefined,forms),context=localSupportContext("details-receipt"),d=details();
 d.citations=[{id:"K:source",kind:"knowledge",title:"内部依据"},{id:"W:1",kind:"web",title:"网页依据",url:"https://example.com",retrievedAt:"2026-10-28T00:00:00Z"}];
 const finish=journal.finish.bind(journal);journal.finish=async()=>{throw new Error("archive disconnected");};
 const interaction={service:forms,conversation:journal,requestId:"receipt"};
 await assert.rejects(withCapabilities({client,revision:"revision",details:d},()=>runSupportAgent(agent,"问题",undefined,"receipt",context,interaction)),/archive disconnected/);
 journal.finish=finish;
 const snapshot=await conversationSnapshot(agent,forms,journal,memoryScope(context),checkpointThreadId("receipt",context),true);assert.equal(snapshot.status,"completed");
 const replay=await withCapabilities({client,revision:"revision",details:details()},()=>runSupportAgent(agent,"问题",undefined,"receipt",context,interaction));
 assert.equal(replay.details?.citations.length,2);assert.equal(replay.details?.citations[1]?.retrievedAt,"2026-10-28T00:00:00Z");assert.equal(model.calls.length,1);
});
test("新知识请求的完成回执缺少详情时保持未知，不退化成无来源成功",async()=>{
 const model=fakeModel().respond(new AIMessage("答案")),forms=new TestInformationBackend(),journal=new TestConversationBackend();
 const agent=createSupportAgent(model,new MemorySaver(),{},{},undefined,forms),context=localSupportContext("missing-details"),d=details(),thread=checkpointThreadId("missing",context),scope=memoryScope(context);
 const finish=journal.finish.bind(journal);journal.finish=async()=>{throw new Error("archive disconnected");};
 await assert.rejects(withCapabilities({client,revision:"revision",details:d},()=>runSupportAgent(agent,"问题",undefined,"missing",context,{service:forms,conversation:journal,requestId:"receipt"})));
 journal.finish=finish;const record=await journal.find(scope,thread,"receipt");
 await agent.graph.updateState({configurable:{thread_id:thread}},{supportCompletionReceipt:{requestId:"receipt",runId:record!.runId,answer:"答案"}});
 const snapshot=await conversationSnapshot(agent,forms,journal,scope,thread,true);assert.equal(snapshot.status,"unknown");assert.equal(model.calls.length,1);
});
test("知识暂停已落 checkpoint 但等待档案失败，缺证据清单保持 unknown 且不发布可提交表单",async()=>{
 const spec={title:"补资料",description:"补充情况",fields:[{key:"issue",label:"情况",type:"text",required:true}]};
 const model=fakeModel().respond(new AIMessage({content:"",tool_calls:[{id:"ask",name:"request_information",args:spec}]})),forms=new TestInformationBackend(),journal=new TestConversationBackend();
 const agent=createSupportAgent(model,new MemorySaver(),{},{},undefined,forms),context=localSupportContext("pause-archive"),d=details();
 d.citations=[{id:"K:source",kind:"knowledge",title:"原文"}];const finish=journal.finish.bind(journal);journal.finish=async()=>{throw new Error("waiting archive lost");};
 await assert.rejects(withCapabilities({client,revision:"revision",details:d},()=>runSupportAgent(agent,"问题",undefined,"pause",context,{service:forms,conversation:journal,requestId:"root"})),/waiting archive lost/);
 journal.finish=finish;const snapshot=await conversationSnapshot(agent,forms,journal,memoryScope(context),checkpointThreadId("pause",context),true);
 assert.equal(snapshot.status,"unknown");assert.equal(snapshot.information,undefined);assert.equal(model.calls.length,1);
});
