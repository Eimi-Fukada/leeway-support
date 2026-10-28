import { fromBuffer } from "yauzl";
import mammoth from "mammoth";
import { AppError } from "../../contracts.ts";
import { normalizedText } from "../text.ts";
import type { DocumentParser } from "./types.ts";
export async function validateDocx(data: Buffer): Promise<void> {
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
export const docxParser: DocumentParser = {
  kind: "docx", label: "DOCX", extensions: [".docx"], validate: validateDocx,
  async parse(data) {
    await validateDocx(data);
    const result = await mammoth.extractRawText({ buffer: data });
    const text = normalizedText(result.value);
    return { text, sections: [{ start: 0, end: text.length, headingPath: [] }], parserId: "mammoth-docx-raw", parserVersion: "1.11.0-v1",
      warnings: ["Word 按段落提取全文，未还原排版、图片和精确表格结构。", ...(result.messages.length ? ["文档包含部分不支持的内容，请对照原文核对。"] : [])] };
  },
};
