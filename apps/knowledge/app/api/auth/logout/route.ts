import { cookies } from "next/headers";
import { service, SESSION_COOKIE } from "../../../../src/server/runtime.ts";
import { errorResponse, json, requireSameOrigin } from "../../../../src/http.ts";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const jar = await cookies();
    await service().logout(jar.get(SESSION_COOKIE)?.value);
    jar.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    return json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
