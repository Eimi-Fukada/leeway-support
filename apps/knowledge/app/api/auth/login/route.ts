import { cookies } from "next/headers";
import { service, SESSION_COOKIE } from "../../../../src/server/runtime.ts";
import { SESSION_SECONDS } from "../../../../src/service.ts";
import { appOrigin, errorResponse, json, readJson, requireSameOrigin } from "../../../../src/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const result = await service().login(await readJson(request));
    const jar = await cookies();
    await service().logout(jar.get(SESSION_COOKIE)?.value);
    jar.set(SESSION_COOKIE, result.token, { httpOnly: true, sameSite: "lax", secure: appOrigin().startsWith("https:"), path: "/", maxAge: SESSION_SECONDS });
    return json({ user: result.user });
  } catch (error) { return errorResponse(error); }
}
