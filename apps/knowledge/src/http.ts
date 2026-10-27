import { AppError } from "./contracts.ts";

export function appOrigin() {
  const url = new URL(process.env.KNOWLEDGE_APP_URL ?? "http://127.0.0.1:3200");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("请配置有效的 KNOWLEDGE_APP_URL origin。");
  return url.origin;
}
export function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== appOrigin()) throw new AppError(403, "请求来源无效，请刷新页面后重试。");
}
export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
export function errorResponse(error: unknown) {
  return error instanceof AppError ? json({ error: error.message }, error.status)
    : json({ error: "服务暂时无法连接，请稍后重试。" }, 503);
}
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AppError(415, "请求格式无效。");
  if (!request.body) throw new AppError(400, "请填写必要信息。");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) { await reader.cancel(); throw new AppError(413, "提交内容过长。"); }
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "请求内容无效。");
  } finally { reader.releaseLock(); }
}
