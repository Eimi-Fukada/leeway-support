import { after } from "next/server";
import { getSupportRuntime } from "../../../../src/server/runtime.ts";
import { json, localRequestError } from "../../../../src/server/request.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

async function handle(request: Request) {
  const rejected = localRequestError(request);
  if (rejected) return rejected;
  try {
    const support = await getSupportRuntime();
    // after 等到响应（包括流）结束再提交追踪，不在返回 Response 时提前刷新。
    after(() => support.flush());
    const response = await support.handle(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Accel-Buffering", "no");
    return new Response(response.body, { status: response.status, headers });
  } catch { return json({ error: "客服服务暂不可用，请核对服务配置。" }, 503); }
}

export { handle as GET, handle as POST, handle as DELETE };
