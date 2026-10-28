import { AppError } from "../contracts.ts";
export class TextParseError extends AppError {
  constructor(public readonly code: "empty_text" | "text_too_large", message: string) { super(422,message); }
}
export function decodeText(data: Buffer): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error();
    return text;
  } catch { throw new AppError(415, "文本文件需为有效 UTF-8 编码，请另存为 UTF-8 后上传。"); }
}
export function normalizedText(text: string): string {
  const value = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!value.trim()) throw new TextParseError("empty_text", "文档没有可用于入库的文本内容。");
  if (value.length > 5_000_000) throw new TextParseError("text_too_large", "解析后的文本过长，请拆分文件。");
  return value;
}
