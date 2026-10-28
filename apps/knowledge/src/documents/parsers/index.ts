import { AppError } from "../../contracts.ts";
import type { DocumentKind } from "../contracts.ts";
import { textParser } from "./text.ts";
import { markdownParser } from "./markdown.ts";
import { docxParser } from "./docx.ts";
import type { DocumentParser, UploadFormat } from "./types.ts";
// 注册表同时决定上传白名单、前台选择器与执行器适配器。
const parsers: readonly DocumentParser[] = [textParser, markdownParser, docxParser];
export function uploadFormats(): UploadFormat[] { return parsers.map(({ kind, label, extensions }) => ({ kind, label, extensions: [...extensions] })); }
export function parserForKind(kind: DocumentKind): DocumentParser {
  const parser = parsers.find((candidate) => candidate.kind === kind);
  if (!parser) throw new AppError(415, "此格式当前没有可用的解析适配器。");
  return parser;
}
export function parserForName(name: string): DocumentParser {
  const extension = `.${name.split(".").at(-1)?.toLowerCase()}`;
  const parser = parsers.find((candidate) => candidate.extensions.includes(extension));
  if (!parser) throw new AppError(415, `暂时支持 ${parsers.map((candidate) => candidate.label).join("、")} 文件。`);
  return parser;
}
