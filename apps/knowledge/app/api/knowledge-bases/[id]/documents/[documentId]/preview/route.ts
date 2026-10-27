import { currentUser, documents } from "../../../../../../../src/server/runtime.ts";
import { errorResponse, json } from "../../../../../../../src/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  try {
    const user = await currentUser(); if (!user) return json({ error: "请先登录。" }, 401);
    const { id, documentId } = await params;
    return json(await documents().preview(user.id, id, documentId));
  } catch (error) { return errorResponse(error); }
}
