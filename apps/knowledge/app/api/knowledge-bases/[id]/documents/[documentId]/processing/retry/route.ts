import { z } from "zod";
import { currentUser, documents } from "../../../../../../../../src/server/runtime.ts";
import { errorResponse, json, readJson, requireSameOrigin } from "../../../../../../../../src/http.ts";
import { AppError } from "../../../../../../../../src/contracts.ts";
export const runtime = "nodejs";
const schema = z.object({ attempt: z.number().int().nonnegative() }).strict();
export async function POST(request: Request, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await currentUser(); if (!user) return json({ error: "请先登录。" }, 401);
    const parsed = schema.safeParse(await readJson(request)); if (!parsed.success) throw new AppError(400, "重试参数无效，请刷新后重试。");
    const { id, documentId } = await params;
    return json(await documents().retryProcessing(user.id, id, documentId, parsed.data.attempt), 202);
  } catch (error) { return errorResponse(error); }
}
