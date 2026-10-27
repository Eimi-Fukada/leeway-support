import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/password.ts";
import { knowledgeInputSchema } from "../src/contracts.ts";
import { errorResponse, json, readJson, requireSameOrigin } from "../src/http.ts";

test("密码哈希有随机盐，正确密码可验证，错误密码/损坏哈希拒绝", async () => {
  const password = "knowledge-test-password";
  const first = await hashPassword(password); const second = await hashPassword(password);
  assert.notEqual(first, second); assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("wrong", first), false);
  assert.equal(await verifyPassword(password, "scrypt:broken"), false);
});
test("知识库输入去除边缘空格，拒绝空名称、过长内容及伪造归属字段", () => {
  assert.deepEqual(knowledgeInputSchema.parse({ name: "  产品资料 " }), { name: "产品资料", description: "" });
  for (const value of [{ name: " " }, { name: "n".repeat(61) }, { name: "资料", description: "n".repeat(301) }, { name: "资料", owner_id: "another-user" }])
    assert.equal(knowledgeInputSchema.safeParse(value).success, false);
});
test("写接口只接受配置同源，拒绝缺失/外部 Origin", () => {
  const origin = process.env.KNOWLEDGE_APP_URL ?? "http://127.0.0.1:3200";
  requireSameOrigin(new Request(`${origin}/api/knowledge-bases`, { headers: { Origin: origin } }));
  const cases: HeadersInit[] = [{}, { Origin: "https://invalid.example" }, { Origin: "null" }];
  for (const headers of cases)
    assert.throws(() => requireSameOrigin(new Request(`${origin}/api/knowledge-bases`, { headers })), /请求来源无效/);
});
test("JSON 请求按实际字节限制体积，并区分格式错误", async () => {
  const make = (body: string, type = "application/json") => new Request("http://127.0.0.1:3200/api/auth/login", { method: "POST", headers: { "Content-Type": type }, body });
  assert.deepEqual(await readJson(make('{"name":"资料"}')), { name: "资料" });
  await assert.rejects(readJson(make("{")), /请求内容无效/);
  await assert.rejects(readJson(make("a", "text/plain")), /请求格式无效/);
  await assert.rejects(readJson(make(JSON.stringify({ name: "中".repeat(3000) }))), /提交内容过长/);
});
test("成功和错误响应禁止缓存，底层错误不回显", async () => {
  assert.equal(json({ ok: true }).headers.get("cache-control"), "no-store");
  const response = errorResponse(new Error("postgresql://secret:password@private/database"));
  assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await response.text(), /postgres|secret|password|private/);
});
