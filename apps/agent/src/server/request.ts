// 当前仍是本机调试入口；统一保护所有 API，不把客户端身份或 Origin 当作业务授权。
export function localRequestError(request: Request): Response | undefined {
  const origin = request.headers.get("origin");
  if (request.headers.get("host") !== "127.0.0.1:3100" || (origin && origin !== "http://127.0.0.1:3100")) {
    return json({ error: "仅允许本机同源访问。" }, 403);
  }
}

export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
