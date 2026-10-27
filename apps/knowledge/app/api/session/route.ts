import { currentUser } from "../../../src/server/runtime.ts";
import { errorResponse, json } from "../../../src/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const user = await currentUser();
    return user ? json({ user }) : json({ error: "请先登录。" }, 401);
  } catch (error) { return errorResponse(error); }
}
