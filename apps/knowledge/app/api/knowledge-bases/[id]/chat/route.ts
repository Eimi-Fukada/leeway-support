import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { currentUser,SESSION_COOKIE } from "../../../../../src/server/runtime.ts";
import { boundedBody,secret,signedHeaders } from "../../../../../src/integrations/signature.ts";
import { requireSameOrigin,json,errorResponse } from "../../../../../src/http.ts";
import { AppError } from "../../../../../src/contracts.ts";
import { z } from "zod";
const bodySchema=z.object({threadId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),requestId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),message:z.string().trim().min(1).max(12000),
 options:z.object({webSearch:z.boolean(),thinkingMode:z.enum(["quick","deep"])}).strict(),submission:z.unknown().optional()}).strict();
export const runtime="nodejs";
export const maxDuration=240;
async function handle(request:Request,baseId:string,operation:"run"|"history"){
 try{
  if(operation==="run")requireSameOrigin(request);
  const user=await currentUser(),token=(await cookies()).get(SESSION_COOKIE)?.value;if(!user||!token)throw new AppError(401,"请先登录。");
  let input:Record<string,unknown>={threadId:new URL(request.url).searchParams.get("thread")};
  if(operation==="run"){let raw:unknown;try{raw=JSON.parse(await boundedBody(request));}catch{throw new AppError(400,"请求格式无效或超出大小限制。");}const parsed=bodySchema.safeParse(raw);if(!parsed.success)throw new AppError(400,"问题或选项格式无效。");input=parsed.data;}
  const path="/api/internal/knowledge-chat",body=JSON.stringify({...input,operation,baseId,userId:user.id,sessionHash:createHash("sha256").update(token).digest("hex"),applicationId:"knowledge-chat"});
  const origin=new URL(process.env.AGENT_SERVICE_URL??"http://127.0.0.1:3100");
  if(!["http:","https:"].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=="/")throw new AppError(503,"Agent 服务地址无效。");
  const response=await fetch(origin.origin+path,{method:"POST",headers:signedHeaders("knowledge-web","agent",path,body,secret("AGENT_KNOWLEDGE_WEB_SECRET")),body,redirect:"error",signal:AbortSignal.any([request.signal,AbortSignal.timeout(190000)])});
  return new Response(response.body,{status:response.status,headers:{"Content-Type":response.headers.get("content-type")??"application/json","Cache-Control":"no-store","X-Accel-Buffering":"no"}});
 }catch(error){return errorResponse(error);}
}
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return handle(request,(await params).id,"run");}
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){return handle(request,(await params).id,"history");}
