import { currentUser, documents } from "../../../../../../../src/server/runtime.ts";
import { errorResponse, json } from "../../../../../../../src/http.ts";
import { AppError } from "../../../../../../../src/contracts.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  try {
    const user = await currentUser(); if (!user) return json({ error: "请先登录。" }, 401);
    const raw = new URL(request.url).searchParams.get("offset") ?? "0";
    const offset = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(offset) || offset>5000) throw new AppError(400, "分块分页参数无效。");
    const { id, documentId } = await params;
    return json(await documents().chunks(user.id, id, documentId, offset));
  } catch (error) { return errorResponse(error); }
}
