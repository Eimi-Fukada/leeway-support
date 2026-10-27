import { fromBuffer } from "yauzl";
import mammoth from "mammoth";
import { AppError } from "../contracts.ts";
import { MAX_FILE_BYTES, type DocumentKind, type TextPreview } from "./contracts.ts";

export function documentName(raw: string): string {
  const name = raw.trim().normalize("NFC");
  if (!name || name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(name)) throw new AppError(400, "文件名无效，最多 180 字符且不能包含路径。");
  return name;
}
export function decodeText(data: Buffer): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error();
    return text;
  } catch { throw new AppError(415, "文本文件需为有效 UTF-8 编码，请另存为 UTF-8 后上传。"); }
}
async function validateDocx(data: Buffer) {
  await new Promise<void>((resolve, reject) => {
    fromBuffer(data, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) { reject(new AppError(415, "Word 文件损坏或不是有效 DOCX。")); return; }
      let total = 0; let count = 0; let document = false; let types = false; let stopped = false;
      function fail() { if (!stopped) { stopped = true; zip.close(); reject(new AppError(415, "Word 文件损坏、加密或解压内容过大。")); } }
      zip.on("error", fail);
      zip.on("entry", (entry) => {
        count++; total += entry.uncompressedSize;
        if (count > 2000 || total > 32 * 1024 * 1024 || entry.generalPurposeBitFlag & 1) { fail(); return; }
        if (entry.fileName === "word/document.xml") document = true;
        if (entry.fileName === "[Content_Types].xml") types = true;
        zip.readEntry();
      });
      zip.on("end", () => { if (!stopped) { stopped = true; document && types ? resolve() : reject(new AppError(415, "文件不是有效 DOCX。")); } });
      zip.readEntry();
    });
  });
}
export async function validateDocument(name: string, data: Buffer): Promise<DocumentKind> {
  if (!data.length) throw new AppError(400, "不能上传空文件。");
  if (data.length > MAX_FILE_BYTES) throw new AppError(413, "每个文件最多 10 MB。");
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (extension === "pdf") {
    if (data.subarray(0, 5).toString("ascii") !== "%PDF-") throw new AppError(415, "文件内容不是 PDF。");
    return "pdf";
  }
  if (extension === "docx") { await validateDocx(data); return "docx"; }
  if (["txt", "md", "markdown"].includes(extension ?? "")) { decodeText(data); return extension === "txt" ? "text" : "markdown"; }
  throw new AppError(415, "暂时支持 PDF、DOCX、TXT 和 Markdown 文件。");
}
export async function textPreview(kind: DocumentKind, data: Buffer): Promise<TextPreview> {
  let text: string;
  if (kind === "docx") {
    try { await validateDocx(data); text = (await mammoth.extractRawText({ buffer: data })).value; }
    catch { throw new AppError(422, "此 Word 文件暂时无法预览，可下载原文查看。"); }
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
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) { await reader.cancel(); throw new AppError(413, "每个文件最多 10 MB。"); }
      parts.push(value);
    }
    return Buffer.concat(parts);
  } finally { reader.releaseLock(); }
}
