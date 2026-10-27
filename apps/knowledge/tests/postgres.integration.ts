import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/database.ts";
import { hashPassword } from "../src/password.ts";
import { KnowledgeService } from "../src/service.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
async function fixture() {
  const pool = createPool(); const id = randomUUID(); const username = `it-${randomUUID()}`;
  const password = "integration-knowledge-password"; const hash = await hashPassword(password);
  await pool.query("INSERT INTO public.knowledge_users(id,username,password_hash) VALUES($1,$2,$3)", [id, username, hash]);
  const service = new KnowledgeService(pool);
  return { id, username, password, pool, service, close: async () => {
    try {
      await pool.query("DELETE FROM public.knowledge_bases WHERE owner_id=$1", [id]);
      await pool.query("DELETE FROM public.knowledge_users WHERE id=$1", [id]);
    } finally { await pool.end(); }
  } };
}
test("PostgreSQL：登录保存 token 哈希，会话可跨服务实例读取；退出、过期与禁用立即失效", async () => {
  const env = await fixture();
  try {
    await assert.rejects(env.service.login({ username: env.username, password: "wrong" }), /账号或密码不正确/);
    const { token, user } = await env.service.login({ username: env.username, password: env.password });
    assert.equal(user.id, env.id);
    const stored = await env.pool.query<{ token_hash: string }>("SELECT token_hash FROM public.knowledge_sessions WHERE user_id=$1", [env.id]);
    assert.notEqual(stored.rows[0]!.token_hash, token);
    const another = new KnowledgeService(env.pool);
    assert.equal((await another.user(token))!.id, env.id);
    await env.service.logout(token); assert.equal(await another.user(token), null);
    const expired = await env.service.login({ username: env.username, password: env.password });
    await env.pool.query("UPDATE public.knowledge_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [env.id]);
    assert.equal(await another.user(expired.token), null);
    const disabled = await env.service.login({ username: env.username, password: env.password });
    await env.pool.query("UPDATE public.knowledge_users SET active=false WHERE id=$1", [env.id]);
    assert.equal(await another.user(disabled.token), null);
  } finally { await env.close(); }
});
test("PostgreSQL：库持久化、名称冲突、并发创建唯一与归属隔离", async () => {
  const env = await fixture();
  try {
    const name = "产品帮助中心";
    const results = await Promise.allSettled([env.service.create(env.id, { name }), env.service.create(env.id, { name })]);
    assert.equal(results.filter((value) => value.status === "fulfilled").length, 1);
    const list = await new KnowledgeService(env.pool).list(env.id);
    assert.equal(list.length, 1); assert.equal(list[0]!.name, name); assert.ok(list[0]!.createdAt.endsWith("Z"));
    assert.deepEqual(await env.service.list(randomUUID()), []);
    await assert.rejects(env.service.create(env.id, { name: "资料", owner_id: randomUUID() }));
    await assert.rejects(env.service.create(env.id, { name: " " }));
  } finally { await env.close(); }
});
test("PostgreSQL：多设备会话独立，退出一个设备不影响另一个设备", async () => {
  const env = await fixture();
  try {
    const first = await env.service.login({ username: env.username, password: env.password });
    const another = new KnowledgeService(env.pool);
    const second = await another.login({ username: env.username, password: env.password });
    assert.notEqual(first.token, second.token);
    assert.equal((await env.service.user(first.token))?.id, env.id);
    assert.equal((await env.service.user(second.token))?.id, env.id);
    await env.service.logout(first.token);
    assert.equal(await another.user(first.token), null);
    assert.equal((await another.user(second.token))?.id, env.id);
  } finally { await env.close(); }
});
