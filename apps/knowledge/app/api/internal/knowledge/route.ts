import { z } from "zod";
import { database,retrieval } from "../../../../src/server/runtime.ts";
import { boundedBody,verifyService,secret } from "../../../../src/integrations/signature.ts";
import { AppError } from "../../../../src/contracts.ts";
import { json,errorResponse } from "../../../../src/http.ts";

const input=z.object({operation:z.enum(["scope","search"]),userId:z.uuid(),sessionHash:z.string().regex(/^[a-f0-9]{64}$/),baseId:z.uuid(),
 applicationId:z.literal("knowledge-chat"),question:z.string().max(4000).optional(),revision:z.string().optional()}).strict();
export async function POST(request:Request){
 try{
  const raw=await boundedBody(request),pool=database();
  try{await verifyService(request,raw,secret("KNOWLEDGE_SUPPORT_AGENT_SECRET"),pool,"knowledge_service_nonces","support-agent","knowledge");}catch{throw new AppError(401,"服务认证失败。");}
  const parsed=input.safeParse(JSON.parse(raw));if(!parsed.success)throw new AppError(400,"请求格式无效。");const value=parsed.data;
  const valid=await pool.query(`SELECT s.user_id FROM public.knowledge_sessions s JOIN public.knowledge_users u ON u.id=s.user_id
    JOIN public.knowledge_bases b ON b.owner_id=u.id JOIN public.knowledge_application_grants g ON g.knowledge_base_id=b.id
    WHERE s.token_hash=$1 AND s.user_id=$2 AND s.expires_at>now() AND u.active=true AND b.id=$3 AND g.application_id=$4 AND g.active=true`,
    [value.sessionHash,value.userId,value.baseId,value.applicationId]);
  if(!valid.rowCount)throw new AppError(403,"登录或知识授权已失效。");
  const revision=await retrieval().scope(value.userId,value.baseId);
  if(value.revision&&value.revision!==revision)throw new AppError(409,"知识范围已变化，请新建会话。");
  return json(value.operation==="scope"?{revision}:await retrieval().search(value.userId,value.baseId,{question:value.question},request.signal));
 }catch(error){return errorResponse(error);}
}
