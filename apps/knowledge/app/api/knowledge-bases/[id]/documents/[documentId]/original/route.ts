import { currentUser, documents } from "../../../../../../../src/server/runtime.ts";
import { errorResponse, json } from "../../../../../../../src/http.ts";
import { byteRange } from "../../../../../../../src/documents/range.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  try {
    const user = await currentUser(); if (!user) return json({ error: "请先登录。" }, 401);
    const { id, documentId } = await params;
    const { document, data } = await documents().original(user.id, id, documentId);
    const pdf = document.kind === "pdf" && new URL(request.url).searchParams.get("download") !== "1";
    const headers = new Headers({ "Content-Type": pdf ? "application/pdf" : "application/octet-stream",
      "Content-Disposition": `${pdf ? "inline" : "attachment"}; filename="document.${document.kind === "markdown" ? "md" : document.kind === "text" ? "txt" : document.kind}"; filename*=UTF-8''${encodeURIComponent(document.name).replace(/['()*]/g, (s: string) => `%${s.charCodeAt(0).toString(16)}`)}`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "bytes",
      "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'self'", "X-Frame-Options": "SAMEORIGIN" });
    const range = request.headers.get("range");
    if (range) {
      const selected = byteRange(range, data.length);
      if (!selected) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${data.length}`, "Cache-Control": "no-store" } });
      const { start, end } = selected;
      headers.set("Content-Range", `bytes ${start}-${end}/${data.length}`); headers.set("Content-Length", String(end - start + 1));
      return new Response(new Uint8Array(data.subarray(start, end + 1)), { status: 206, headers });
    }
    headers.set("Content-Length", String(data.length));
    return new Response(new Uint8Array(data), { headers });
  } catch (error) { return errorResponse(error); }
}
