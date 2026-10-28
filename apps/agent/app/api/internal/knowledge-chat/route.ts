import { z } from "zod";
import { randomUUID } from "node:crypto";
import { boundedBody,verifyService,secret } from "../../../../src/integrations/signature.ts";
import { knowledgeServices } from "../../../../src/knowledge/services.ts";
import { KnowledgeClient } from "../../../../src/knowledge/client.ts";
import { runOptionsSchema,runDetailsSchema,withCapabilities,type RunDetails } from "../../../../src/knowledge/runtime.ts";
import { memoryScope,checkpointThreadId,type SupportContext } from "../../../../src/support-context.ts";
import { runSupportAgent } from "../../../../src/agent/run.ts";
import { conversationSnapshot } from "../../../../src/conversations/execution.ts";
import { submissionSchema } from "../../../../src/interactions/contracts.ts";
import { after } from "next/server";

export const runtime="nodejs";
export const maxDuration=240;
const input=z.object({operation:z.enum(["run","history"]),threadId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),requestId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
 message:z.string().trim().min(1).max(12000).optional(),options:runOptionsSchema.optional(),submission:submissionSchema.optional(),
 userId:z.uuid(),sessionHash:z.string().regex(/^[a-f0-9]{64}$/),baseId:z.uuid(),applicationId:z.literal("knowledge-chat")}).strict();
export async function POST(request:Request){
 try{
  const services=await knowledgeServices(),raw=await boundedBody(request);
  after(()=>services.tracing.flush());
  try{await verifyService(request,raw,secret("AGENT_KNOWLEDGE_WEB_SECRET"),services.pool,"support_service_nonces","knowledge-web","agent");}catch{return Response.json({error:"服务认证失败。"},{status:401});}
  let decoded:unknown;try{decoded=JSON.parse(raw);}catch{return Response.json({error:"请求 JSON 无效。"},{status:400});}
  const parsed=input.safeParse(decoded);if(!parsed.success)return Response.json({error:"请求参数无效。"},{status:400});const value=parsed.data;
  if(value.submission&&value.requestId!==value.submission.submissionId)return Response.json({error:"恢复请求标识不一致。"},{status:400});
  const support:SupportContext={identitySource:"business-authenticated",integrationId:"knowledge-web",productId:`knowledge-${value.baseId}`,subject:{kind:"user",id:value.userId}};
  const scope=memoryScope(support),thread=checkpointThreadId(value.threadId,support);
  const client=new KnowledgeClient({userId:value.userId,sessionHash:value.sessionHash,baseId:value.baseId,applicationId:value.applicationId},request.signal);
  const revision=await client.scope();
  if(value.operation==="run")await services.pool.query("INSERT INTO public.support_knowledge_threads(scope,thread_id,base_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[scope,thread,value.baseId,revision]);
  const bound=(await services.pool.query("SELECT base_id,revision FROM public.support_knowledge_threads WHERE scope=$1 AND thread_id=$2",[scope,thread])).rows[0];
  if(!bound&&value.operation==="history")return Response.json({snapshot:{status:"empty",historyComplete:true,messages:[],requests:[]},results:[]},{headers:{"Cache-Control":"no-store"}});
  if(bound.base_id!==value.baseId||bound.revision!==revision)return Response.json({error:"会话知识范围已变化，请新建会话。"},{status:409});
  if(value.operation==="history"){
   const snapshot=await services.information.withThread(scope,thread,()=>conversationSnapshot(services.agent,services.information,services.conversation,scope,thread,true));
   const records=await services.pool.query("SELECT request_id,result FROM public.support_conversation_requests WHERE scope=$1 AND thread_id=$2 ORDER BY sequence",[scope,thread]);
   return Response.json({snapshot,results:records.rows},{headers:{"Cache-Control":"no-store"}});
  }
  if(!value.message||!value.requestId)return Response.json({error:"缺少问题或请求标识。"},{status:400});
  let options=runOptionsSchema.parse(value.options??{});
  if(value.submission){
   const existing=(await services.pool.query("SELECT options FROM public.support_run_options WHERE scope=$1 AND thread_id=$2 AND request_id=$3",[scope,thread,value.requestId])).rows[0];
   const original=(await services.pool.query(`SELECT o.options FROM public.support_run_options o JOIN public.support_conversation_requests r
    ON r.scope=o.scope AND r.thread_id=o.thread_id AND r.request_id=o.request_id WHERE r.scope=$1 AND r.thread_id=$2 AND r.result->'information'->>'formId'=$3 ORDER BY r.sequence LIMIT 1`,[scope,thread,value.submission.formId])).rows[0];
   if(existing||original)options=runOptionsSchema.parse((existing??original).options);
  }
  await services.pool.query("INSERT INTO public.support_run_options(scope,thread_id,request_id,options) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[scope,thread,value.requestId,JSON.stringify(options)]);
  const saved=(await services.pool.query("SELECT options FROM public.support_run_options WHERE scope=$1 AND thread_id=$2 AND request_id=$3",[scope,thread,value.requestId])).rows[0];
  if(JSON.stringify(saved.options)!==JSON.stringify(options)&&!(saved.options.webSearch===options.webSearch&&saved.options.thinkingMode===options.thinkingMode))return Response.json({error:"请求选项与原请求不一致。"},{status:409});
  const previous=await services.pool.query("SELECT result FROM public.support_conversation_requests WHERE scope=$1 AND thread_id=$2 AND result IS NOT NULL ORDER BY sequence",[scope,thread]);
  const citations=new Map<string,RunDetails["citations"][number]>();
  for(const record of previous.rows){const parsed=runDetailsSchema.safeParse(record.result?.details);if(parsed.success)for(const citation of parsed.data.citations)citations.set(citation.id,citation);}
  const details:RunDetails={options,citations:[...citations.values()],searchCalls:0,model:process.env.OPENAI_MODEL??""};
  const runId=randomUUID(),messageId=`assistant-${value.requestId}`,encoder=new TextEncoder();
  const stream=new ReadableStream({start(controller){
   const emit=(event:unknown)=>{try{controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));}catch{/* 已断开，signal 取消执行 */}};
   void withCapabilities({client,revision,details,emit:event=>emit({type:"CUSTOM",...event})},async()=>{
    emit({type:"RUN_STARTED",threadId:value.threadId,runId});emit({type:"TEXT_MESSAGE_START",messageId,role:"assistant"});
    let streamed=false;
    try{
     const result=await runSupportAgent(services.agent,value.message!,event=>{if(event.type==="text"){streamed=true;emit({type:"TEXT_MESSAGE_CONTENT",messageId,delta:event.text});}},value.threadId,support,
      {service:services.information,conversation:services.conversation,requestId:value.requestId,signal:request.signal,submission:value.submission});
     if(!streamed&&result.answer)emit({type:"TEXT_MESSAGE_CONTENT",messageId,delta:result.answer});
     emit({type:"TEXT_MESSAGE_END",messageId});emit({type:"CUSTOM",name:"support.result",value:result});emit({type:"RUN_FINISHED",threadId:value.threadId,runId});
    }catch{emit({type:"RUN_ERROR",code:"RUN_FAILED",message:"本轮未确认完成，请刷新核对状态；不会自动重新执行。"});}
    finally{try{controller.close();}catch{/* 已取消 */}}
   });
  }});
  return new Response(stream,{headers:{"Content-Type":"text/event-stream","Cache-Control":"no-store","X-Accel-Buffering":"no"}});
 }catch{return Response.json({error:"请求无效或服务暂不可用。"},{status:503});}
}
