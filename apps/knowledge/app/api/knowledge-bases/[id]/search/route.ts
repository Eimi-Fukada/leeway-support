import { currentUser, retrieval } from "../../../../../src/server/runtime.ts";
import { requireSameOrigin, readJson, json, errorResponse } from "../../../../../src/http.ts";
import { AppError } from "../../../../../src/contracts.ts";

export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
  try {
    requireSameOrigin(request);const user=await currentUser();
    if(!user)throw new AppError(401,"请先登录。");
    return json(await retrieval().search(user.id,(await params).id,await readJson(request,65536),request.signal));
  }catch(error){return errorResponse(error);}
}
