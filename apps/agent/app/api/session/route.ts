import { developmentContext } from "../../../src/server/context.ts";
import { json, localRequestError } from "../../../src/server/request.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const rejected = localRequestError(request);
  if (rejected) return rejected;
  try { return json({ user: developmentContext().subject.id }); }
  catch { return json({ error: "开发身份未配置，请检查服务端启动参数。" }, 503); }
}
