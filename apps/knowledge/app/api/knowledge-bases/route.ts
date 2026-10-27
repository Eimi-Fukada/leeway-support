import { currentUser, service } from "../../../src/server/runtime.ts";
import { errorResponse, json, readJson, requireSameOrigin } from "../../../src/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const user = await currentUser();
    return user ? json({ knowledgeBases: await service().list(user.id) }) : json({ error: "请先登录。" }, 401);
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await currentUser();
    return user ? json({ knowledgeBase: await service().create(user.id, await readJson(request)) }, 201) : json({ error: "请先登录。" }, 401);
  } catch (error) { return errorResponse(error); }
}
