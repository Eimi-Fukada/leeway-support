import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AIMessage,SystemMessage,createMiddleware,tool } from "langchain";
import { createModel } from "../config/model.ts";
import type { KnowledgeClient,KnowledgeEvidence } from "./client.ts";

export const runOptionsSchema=z.object({webSearch:z.boolean().default(false),thinkingMode:z.enum(["quick","deep"]).default("quick")}).strict();
export type RunOptions=z.infer<typeof runOptionsSchema>;
export interface Citation {id:string;kind:"knowledge"|"web";title:string;url?:string;retrievedAt?:string;evidence?:KnowledgeEvidence}
export interface RunDetails {options:RunOptions;citations:Citation[];searchCalls:number;model:string;providerResponses?:{id:string;usage:unknown;searchCalls:number}[]}
export const runDetailsSchema=z.object({options:runOptionsSchema,citations:z.array(z.object({id:z.string(),kind:z.enum(["knowledge","web"]),title:z.string(),url:z.string().optional(),retrievedAt:z.string().optional(),evidence:z.object({evidenceId:z.string(),documentId:z.uuid(),documentName:z.string(),knowledgeBaseId:z.uuid(),chunkId:z.uuid(),text:z.string(),generationId:z.string(),sourceSha256:z.string(),headingPath:z.array(z.string())}).passthrough().optional()})),searchCalls:z.number().int().nonnegative(),model:z.string(),providerResponses:z.array(z.object({id:z.string(),usage:z.unknown(),searchCalls:z.number().int().nonnegative()})).optional()});
interface Capabilities {client:KnowledgeClient;revision:string;details:RunDetails;emit?:(event:{name:string;value:unknown})=>void}
const storage=new AsyncLocalStorage<Capabilities>();
export function currentCapabilities(){return storage.getStore();}
export function withCapabilities<T>(value:Capabilities,work:()=>Promise<T>){return storage.run(value,work);}
export function collectProviderContent(content:unknown){
 const current=storage.getStore();if(!current||!Array.isArray(content))return;
 for(const block of content){
  if(!block||typeof block!=="object")continue;
  if(block.type==="web_search_call")current.details.searchCalls++;
  if(Array.isArray(block.annotations))for(const a of block.annotations){
   if(a.type!=="url_citation"&&!(a.type==="citation"&&a.source==="url_citation"))continue;
   const url=typeof a.url==="string"?a.url:undefined;
   if(!url||!/^https?:\/\//.test(url))continue;
   if(!current.details.citations.some(c=>c.kind==="web"&&c.url===url))current.details.citations.push({id:`W:${createHash("sha256").update(url).digest("hex")}`,kind:"web",title:typeof a.title==="string"?a.title:url,url,retrievedAt:new Date().toISOString()});
  }
 }
}
export function knowledgeTool(){return tool(async({query})=>{
 const current=storage.getStore();if(!current)throw new Error("当前入口没有知识授权。");
 current.emit?.({name:"support.retrieval",value:{status:"started"}});
 const response=await current.client.search(query,current.revision);
 current.emit?.({name:"support.retrieval",value:{status:"completed",retrievalId:response.retrievalId}});
 for(const e of response.evidence){if(!current.details.citations.some(c=>c.id===`K:${e.evidenceId}`))current.details.citations.push({id:`K:${e.evidenceId}`,kind:"knowledge",title:e.documentName,evidence:e});}
 return {status:response.status,retrievalId:response.retrievalId,evidence:response.evidence.map(e=>({citationId:`K:${e.evidenceId}`,documentName:e.documentName,headingPath:e.headingPath,text:e.text}))};
 },{name:"search_knowledge",description:"查询当前授权知识库的内部制度、产品说明和规则。不得用网页代替内部事实；普通聊天及公开信息可不调用。",schema:z.object({query:z.string().trim().min(1).max(4000)}).strict()});}

export function capabilitiesMiddleware(){
 const models=new Map<string,ReturnType<typeof createModel>>();
 return createMiddleware({name:"KnowledgeCapabilities",wrapModelCall:async(request,handler)=>{
  const current=storage.getStore();if(!current)return handler(request);
  if(await current.client.scope()!==current.revision)throw new Error("知识范围变化，请新建会话。");
  const {webSearch,thinkingMode}=current.details.options,key=`${thinkingMode}:${webSearch}`;
  let model=models.get(key);if(!model){model=createModel({effort:thinkingMode==="deep"?"high":"low",webSearch});models.set(key,model);}
  return handler({...request,model,tools:webSearch?[...request.tools,{type:"web_search"}]:request.tools,
   systemMessage:request.systemMessage.concat(new SystemMessage(`本轮服务端时间：${new Date().toISOString()}；用户时区 Asia/Shanghai。联网搜索${webSearch?"已允许；公开最新事实必须实际搜索核实":"未允许；不能声称已核实实时信息"}。快速/深度仅改变推理强度，不改变权限。`))});
 },afterModel:(state)=>{
  const message=state.messages.at(-1),current=storage.getStore();collectProviderContent(message?.content);
  if(current&&message&&AIMessage.isInstance(message)){
   const outputs=message.additional_kwargs?.tool_outputs;
   const searches=Array.isArray(outputs)?outputs.filter(item=>item&&typeof item==="object"&&"type" in item&&item.type==="web_search_call").length:0;
   current.details.searchCalls+=searches;
   if(searches)current.emit?.({name:"support.web_search",value:{status:"completed",calls:searches}});
   (current.details.providerResponses??=[]).push({id:String(message.response_metadata?.id??message.id??""),usage:message.usage_metadata,searchCalls:searches});
  }
 }});
}
