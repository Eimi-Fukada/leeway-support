import { z } from "zod";
import { signedHeaders,secret } from "../integrations/signature.ts";
const evidence=z.object({evidenceId:z.string(),documentId:z.uuid(),documentName:z.string(),knowledgeBaseId:z.uuid(),chunkId:z.uuid(),text:z.string(),generationId:z.string(),sourceSha256:z.string(),headingPath:z.array(z.string())}).passthrough();
const result=z.object({retrievalId:z.uuid(),status:z.enum(["ok","no_match","no_ready_documents"]),scopeRevision:z.string(),budgetLimited:z.boolean(),evidence:z.array(evidence)});
export type KnowledgeEvidence=z.infer<typeof evidence>;
export interface Delegation {userId:string;sessionHash:string;baseId:string;applicationId:"knowledge-chat"}
export class KnowledgeClient {
 constructor(private readonly delegation:Delegation,private readonly signal?:AbortSignal){}
 async call(operation:"scope"|"search",question?:string,revision?:string){
  const path="/api/internal/knowledge",body=JSON.stringify({...this.delegation,operation,...(question?{question}:{}),...(revision?{revision}:{})});
  const origin=new URL(process.env.KNOWLEDGE_SERVICE_URL??"http://127.0.0.1:3200");
  if(!["http:","https:"].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=="/")throw new Error("知识服务地址无效。");
  const response=await fetch(origin.origin+path,{method:"POST",headers:signedHeaders("support-agent","knowledge",path,body,secret("KNOWLEDGE_SUPPORT_AGENT_SECRET")),body,redirect:"error",
   signal:this.signal?AbortSignal.any([this.signal,AbortSignal.timeout(50000)]):AbortSignal.timeout(50000)});
  if(!response.ok)throw new Error(`知识服务拒绝或未完成请求（${response.status}）。`);
  return response.json();
 }
 async scope(){return z.object({revision:z.string()}).parse(await this.call("scope")).revision;}
 async search(query:string,revision:string){return result.parse(await this.call("search",query,revision));}
}
