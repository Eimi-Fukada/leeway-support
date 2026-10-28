import type { DocumentKind } from "../contracts.ts";
export interface UploadFormat { kind: DocumentKind; label: string; extensions: string[] }
export interface ParsedSection { start: number; end: number; headingPath: string[] }
export interface ParsedDocument {
  text: string; sections: ParsedSection[]; parserId: string; parserVersion: string; warnings: string[];
}
export interface DocumentParser extends UploadFormat {
  validate(data: Buffer): Promise<void>;
  parse(data: Buffer): Promise<ParsedDocument>;
}
