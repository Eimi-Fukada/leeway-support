import { AppError } from "../contracts.ts";
import { MAX_FILE_BYTES, type DocumentKind, type TextPreview } from "./contracts.ts";
import { parserForName, parserForKind } from "./parsers/index.ts";
import { decodeText } from "./text.ts";
export { decodeText } from "./text.ts";

export function documentName(raw: string): string {
  const name = raw.trim().normalize("NFC");
  if (!name || name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(name)) throw new AppError(400, "文件名无效，最多 180 字符且不能包含路径。");
  return name;
}
export async function validateDocument(name: string, data: Buffer): Promise<DocumentKind> {
  if (!data.length) throw new AppError(400, "不能上传空文件。");
  if (data.length > MAX_FILE_BYTES) throw new AppError(413, "每个文件最多 10 MB。");
  const parser = parserForName(name);
  await parser.validate(data);
  return parser.kind;
}
export async function textPreview(kind: DocumentKind, data: Buffer): Promise<TextPreview> {
  let text: string;
  if (kind !== "text" && kind !== "markdown") {
    try { text = (await parserForKind(kind).parse(data)).text; }
    catch { throw new AppError(422, "此文件暂时无法预览，可下载原文查看。"); }
  } else text = decodeText(data);
  return { text: text.slice(0, 100_000), truncated: text.length > 100_000 };
}
export async function readUpload(request: Request): Promise<Buffer> {
  if (!request.body) throw new AppError(400, "请选择文件。");
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_FILE_BYTES) throw new AppError(413, "每个文件最多 10 MB。");
  const reader = request.body.getReader(); const parts: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) { await reader.cancel(); throw new AppError(413, "每个文件最多 10 MB。"); }
      parts.push(value);
    }
    return Buffer.concat(parts);
  } finally { reader.releaseLock(); }
}
