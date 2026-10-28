import { z } from "zod";
import { currentUser,documents,indexing } from "../../../../../../../../src/server/runtime.ts";
import { errorResponse,json,readJson,requireSameOrigin } from "../../../../../../../../src/http.ts";
import { AppError } from "../../../../../../../../src/contracts.ts";
export const runtime="nodejs";
export const maxDuration=60;
const schema=z.object({attempt:z.number().int().nonnegative()}).strict();
export async function POST(request:Request,{params}:{params:Promise<{id:string;documentId:string}>}){
  try{
    requireSameOrigin(request);const user=await currentUser();if(!user)return json({error:"请先登录。"},401);
    const parsed=schema.safeParse(await readJson(request));if(!parsed.success)throw new AppError(400,"核对参数无效。");
    const {id,documentId}=await params;
    const state=await documents().processing(user.id,id,documentId);
    if(!state.canReconcile)throw new AppError(409,"当前没有需要核对的索引结果。");
    await indexing().reconcile(documentId,parsed.data.attempt);
    return json(await documents().processing(user.id,id,documentId));
  }catch(error){return errorResponse(error);}
}
