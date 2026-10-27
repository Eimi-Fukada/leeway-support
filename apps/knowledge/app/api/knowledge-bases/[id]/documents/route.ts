import { currentUser, documents } from "../../../../../src/server/runtime.ts";
import { AppError } from "../../../../../src/contracts.ts";
import { errorResponse, json, requireSameOrigin } from "../../../../../src/http.ts";
import { readUpload } from "../../../../../src/documents/files.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await currentUser(); if (!user) return json({ error: "请先登录。" }, 401);
    return json({ documents: await documents().list(user.id, (await params).id) });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, { params }: Params) {
  try {
    requireSameOrigin(request);
    const user = await currentUser(); if (!user) return json({ error: "请先登录。" }, 401);
    const { id } = await params;
    await documents().authorize(user.id, id);
    let name: string;
    try { name = decodeURIComponent(request.headers.get("x-file-name") ?? ""); }
    catch { throw new AppError(400, "文件名无效。"); }
    const result = await documents().upload(user.id, id, name, await readUpload(request));
    return json(result, result.duplicate ? 200 : 201);
  } catch (error) { return errorResponse(error); }
}
