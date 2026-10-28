import { decodeText, normalizedText } from "../text.ts";
import type { DocumentParser } from "./types.ts";
export const textParser: DocumentParser = {
  kind: "text", label: "TXT", extensions: [".txt"],
  async validate(data) { decodeText(data); },
  async parse(data) {
    const text = normalizedText(decodeText(data));
    return { text, sections: [{ start: 0, end: text.length, headingPath: [] }], parserId: "utf8-text", parserVersion: "1", warnings: [] };
  },
};
