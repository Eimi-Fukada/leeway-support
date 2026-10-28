import { Lexer } from "marked";
import { decodeText, normalizedText } from "../text.ts";
import type { DocumentParser, ParsedSection } from "./types.ts";
export const markdownParser: DocumentParser = {
  kind: "markdown", label: "Markdown", extensions: [".md", ".markdown"],
  async validate(data) { decodeText(data); },
  async parse(data) {
    const text = normalizedText(decodeText(data));
    const sections: ParsedSection[] = [];
    const headings: Array<{ depth: number; text: string }> = [];
    let sectionStart = 0; let offset = 0; let headingPath: string[] = [];
    // 不渲染 HTML，不访问链接；围栏代码内的 # 不会误识别成章节。
    for (const token of Lexer.lex(text, { gfm: true })) {
      const start = text.indexOf(token.raw, offset);
      if (start < 0) throw new Error("Markdown source position mismatch");
      if (token.type === "heading") {
        if (start > sectionStart && text.slice(sectionStart, start).trim()) sections.push({ start: sectionStart, end: start, headingPath });
        while (headings.length && headings.at(-1)!.depth >= token.depth) headings.pop();
        headings.push({ depth: token.depth, text: token.text });
        headingPath = headings.map((heading) => heading.text); sectionStart = start;
      }
      offset = start + token.raw.length;
    }
    if (text.slice(sectionStart).trim()) sections.push({ start: sectionStart, end: text.length, headingPath });
    if (!sections.length) sections.push({ start: 0, end: text.length, headingPath: [] });
    return { text, sections, parserId: "marked-markdown", parserVersion: "18.1.2-v1", warnings: [] };
  },
};
