import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parserForKind, parserForName, uploadFormats } from "../src/documents/parsers/index.ts";
import { chunkDocument, CHUNK_CONFIG } from "../src/documents/chunker.ts";

test("解析注册表控制上传格式；拒绝 PDF/旧 DOC，支持大小写与 Markdown 扩展名", () => {
  assert.deepEqual(uploadFormats().flatMap((format) => format.extensions), [".txt", ".md", ".markdown", ".docx"]);
  assert.equal(parserForName("资料.DOCX").kind, "docx");
  assert.equal(parserForName("资料.MARKDOWN").kind, "markdown");
  assert.throws(() => parserForName("资料.pdf"), /暂时支持/);
  assert.throws(() => parserForName("资料.doc"), /暂时支持/);
});
test("TXT 完整解码、换行规范、空白/乱码拒绝，超过预览上限仍保留尾部", async () => {
  const parser = parserForKind("text");
  const parsed = await parser.parse(Buffer.from("\uFEFF首行\r\n" + "正文\n".repeat(40000) + "TAIL_完整原文"));
  assert.ok(parsed.text.length>100000); assert.ok(parsed.text.endsWith("TAIL_完整原文"));
  assert.ok(!parsed.text.includes("\r")); assert.ok(!parsed.text.startsWith("\uFEFF"));
  await assert.rejects(parser.parse(Buffer.from(" \n\t ")), /没有可用于/);
  await assert.rejects(parser.parse(Buffer.from([0xff])), /UTF-8/);
});
test("Markdown 词法识别标题层级，围栏和缩进代码内的假标题不拆章，原始表格/列表/链接不丢失", async () => {
  const text = "前言\n\n# 规则\n\n七天内退款。\n\n## 例外\n\n- 续费不适用\n\n```md\n# 这是代码不是章节\n```\n\n|类型|条件|\n|---|---|\n|首次|七天|\n\n[帮助](https://example.invalid)\n\n# 联系\n提交工单。";
  const parsed = await parserForKind("markdown").parse(Buffer.from(text));
  assert.equal(parsed.text, text);
  assert.deepEqual(parsed.sections.map((section) => section.headingPath), [[],["规则"],["规则","例外"],["联系"]]);
  assert.equal(parsed.sections.map((section) => text.slice(section.start,section.end)).join(""), text);
});
test("DOCX 使用真实 ZIP/XML 提取完整正文，超过十万字符的尾部仍存在，不复用预览截断", async () => {
  const data = await readFile(new URL("./fixtures/full-text.docx", import.meta.url));
  const parsed = await parserForKind("docx").parse(data);
  assert.ok(parsed.text.length>100000);
  assert.match(parsed.text, /DOCX_END_SENTINEL_7319/);
  assert.ok(parsed.text.indexOf("DOCX_END_SENTINEL_7319")>100000);
  assert.equal(parsed.sections[0]!.end,parsed.text.length);
  await assert.rejects(parserForKind("docx").parse(Buffer.from("broken")), /Word 文件/);
});
test("统一分块保留章节、精确来源位置和全部非空白文本；稳定 ID 可重复重建且不跨文档复用", async () => {
  const parsed = await parserForKind("markdown").parse(Buffer.from("# 退款\n\n" + "购买七天内可以申请，但续费属于例外。\n".repeat(120) + "\n# 权限\n仅管理员可以提交。"));
  const id = randomUUID(); const chunks = await chunkDocument(id,parsed);
  assert.ok(chunks.length>2);
  const covered = new Uint8Array(parsed.text.length);
  for (const chunk of chunks) {
    assert.equal(chunk.text, parsed.text.slice(chunk.start,chunk.end));
    assert.ok(chunk.text.length<=CHUNK_CONFIG.size);
    for (let index=chunk.start;index<chunk.end;index++) covered[index]=1;
    assert.deepEqual(chunk.headingPath, parsed.sections[chunk.section]!.headingPath);
  }
  for (let index=0;index<parsed.text.length;index++) if (/\S/.test(parsed.text[index]!)) assert.equal(covered[index],1,`uncovered source ${index}`);
  assert.equal(new Set(chunks.map((chunk) => chunk.id)).size,chunks.length);
  assert.deepEqual(await chunkDocument(id,parsed),chunks);
  assert.notEqual((await chunkDocument(randomUUID(),parsed))[0]!.id,chunks[0]!.id);
});
test("最终字符兜底不切断 emoji 代理对，错误适配器遗漏正文时拒绝生成片段", async () => {
  const parsed = await parserForKind("text").parse(Buffer.from("A😀".repeat(1200)));
  for (const chunk of await chunkDocument(randomUUID(),parsed)) assert.equal(Buffer.from(chunk.text,"utf8").toString("utf8"),chunk.text);
  await assert.rejects(chunkDocument(randomUUID(),{...parsed,sections:[{start:10,end:20,headingPath:[]}]}), /Invalid parsed|omit source/);
});
