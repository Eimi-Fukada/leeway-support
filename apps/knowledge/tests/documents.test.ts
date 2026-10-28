import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_BYTES } from "../src/documents/contracts.ts";
import { documentName, readUpload, textPreview, validateDocument } from "../src/documents/files.ts";
import { LocalDocumentStorage } from "../src/documents/storage.ts";
import { byteRange } from "../src/documents/range.ts";

test("文件校验：名称路径、空文件、超限、扩展名伪装和非法编码拒绝", async () => {
  for (const name of ["../test.txt", "a\\test.txt", "bad\r\n.txt", " ", "a".repeat(181)]) assert.throws(() => documentName(name));
  assert.equal(documentName(" 产品说明.md "), "产品说明.md");
  await assert.rejects(validateDocument("a.txt", Buffer.alloc(0)), /空文件/);
  await assert.rejects(validateDocument("a.txt", Buffer.alloc(MAX_FILE_BYTES + 1)), /10 MB/);
  await assert.rejects(validateDocument("a.html", Buffer.from("hello")), /暂时支持/);
  await assert.rejects(validateDocument("a.pdf", Buffer.from("%PDF-1.4\n%%EOF")), /暂时支持/);
  await assert.rejects(validateDocument("a.docx", Buffer.from("not-docx")), /Word 文件/);
  await assert.rejects(validateDocument("a.txt", Buffer.from([0xff, 0x00])), /UTF-8/);
  assert.equal(await validateDocument("a.md", Buffer.from("# 测试\n正文")), "markdown");
});
test("文本预览保留正文为纯文本，超长正文截断并明确标识", async () => {
  const source = "<script>alert(1)</script>\n# 文档";
  assert.deepEqual(await textPreview("markdown", Buffer.from(source)), { text: source, truncated: false });
  const preview = await textPreview("text", Buffer.from("a".repeat(100001)));
  assert.equal(preview.text.length, 100000); assert.equal(preview.truncated, true);
});
test("上传请求按实际字节限制大小，不依赖 Content-Length", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_FILE_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  const request = new Request("http://localhost/upload", { method: "POST", body, duplex: "half" } as RequestInit);
  await assert.rejects(readUpload(request), /10 MB/);
  assert.equal((await readUpload(new Request("http://localhost/upload", { method: "POST", body: "hello" }))).toString(), "hello");
});
test("私有文件存储仅接受内部 key，写入后新实例能读取，禁止覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "leeway-file-unit-"));
  try {
    const store = new LocalDocumentStorage(root); const key = randomUUID();
    await assert.rejects(store.write("../../escape", Buffer.from("x")), /无效存储引用/);
    await store.write(key, Buffer.from("持久原文"));
    assert.equal((await new LocalDocumentStorage(root).read(key)).toString(), "持久原文");
    await assert.rejects(store.write(key, Buffer.from("overwrite")));
    await store.remove(key); await assert.rejects(store.read(key), /无法读取/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("PDF 字节范围支持起止/开放/后缀，超出末尾截断，多范围或非法偏移拒绝", () => {
  assert.deepEqual(byteRange("bytes=0-15", 100), { start: 0, end: 15 });
  assert.deepEqual(byteRange("bytes=80-", 100), { start: 80, end: 99 });
  assert.deepEqual(byteRange("bytes=-20", 100), { start: 80, end: 99 });
  assert.deepEqual(byteRange("bytes=80-200", 100), { start: 80, end: 99 });
  for (const input of ["bytes=100-", "bytes=80-20", "bytes=0-1,4-5", "bytes=-0", "bytes=-", "bytes=99999999999999999999-"]) assert.equal(byteRange(input, 100), null);
});
