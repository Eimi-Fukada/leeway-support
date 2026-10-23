import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createCheckpointer } from "../src/config/checkpoint.ts";
import { AIMessage, fakeModel } from "langchain";
import { createSupportAgent } from "../src/agent/agent.ts";
import { runSupportCli } from "../src/cli/chat.ts";
import { runSupportAgent } from "../src/agent/run.ts";
import { createMemory } from "../src/config/memory.ts";
import { createDatabasePool } from "../src/config/database.ts";
import { localSupportContext, memoryScope } from "../src/support-context.ts";

const exec = promisify(execFile);

test("真实 PostgreSQL：长期记忆跨进程/新 thread 读取，与 checkpoint 独立", { timeout: 60_000 }, async () => {
  const user = `integration-memory-${randomUUID()}`;
  const pool = createDatabasePool();
  try {
    for (const phase of ["seed", "check"]) {
      const { stdout } = await exec(process.execPath, ["--import", "tsx", "--import", "./tests/setup.ts", "tests/fixtures/long-term-worker.ts", phase, user], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 25_000,
      });
      assert.match(stdout, /long-term-worker-ok/);
    }
  } finally {
    const scope = memoryScope(localSupportContext(user));
    try {
      await pool.query("DELETE FROM public.support_memory_operations WHERE scope=$1", [scope]);
      await pool.query("DELETE FROM public.support_memories WHERE scope=$1", [scope]);
    } finally { await pool.end(); }
  }
});

test("真实 PostgreSQL：记忆幂等、版本竞争、用户隔离、脱敏和遗忘", { timeout: 30_000 }, async () => {
  const memory = await createMemory();
  const pool = createDatabasePool();
  const alice = localSupportContext(`integration-memory-${randomUUID()}`);
  const bob = localSupportContext(`integration-memory-${randomUUID()}`);
  const fact = "公司只能离线部署，联系 user@example.com";
  const base = { threadId: "fixture-thread", messageId: "fixture-message", sourceText: fact, evidenceQuote: fact };
  try {
    const input = { ...base, operationId: "save-op", change: { action: "save" as const, content: fact } };
    const saved = await memory.service.write(alice, input);
    assert.equal(saved.status, "saved");
    if (saved.status !== "saved") throw new Error("expected saved");
    assert.deepEqual(await memory.service.write(alice, input), saved);
    assert.equal((await memory.service.list(alice)).length, 1);
    assert.match((await memory.service.list(alice))[0]!.content, /REDACTED_EMAIL/);
    assert.deepEqual(await memory.service.list(bob), []);
    const update = { action: "update" as const, id: saved.id, expectedVersion: 1, content: "公司目前可以联网" };
    const revised = { threadId: "t2", messageId: "m2", sourceText: "公司目前可以联网", evidenceQuote: "公司目前可以联网" };
    assert.deepEqual(await memory.service.write(bob, { ...revised, operationId: "foreign", change: update }), { status: "rejected", code: "NOT_FOUND" });
    const results = await Promise.all(["update-1", "update-2"].map((operationId) => memory.service.write(alice, { ...revised, operationId, change: update })));
    assert.equal(results.filter((result) => result.status === "updated").length, 1);
    assert.ok(results.some((result) => result.status === "rejected" && result.code === "VERSION_CONFLICT"));
    assert.deepEqual(await memory.service.write(alice, { ...input, change: { action: "save", content: "不同内容" } }), { status: "rejected", code: "OPERATION_CONFLICT" });
    const forgotten = await memory.service.write(alice, { threadId: "t3", messageId: "m3", sourceText: "删除部署记忆", evidenceQuote: "删除部署记忆", operationId: "forget",
      change: { action: "forget", id: saved.id, expectedVersion: 2 } });
    assert.equal(forgotten.status, "forgotten");
    assert.deepEqual(await memory.service.list(alice), []);
    const tombstone = await pool.query("SELECT content, deleted, version FROM public.support_memories WHERE scope=$1 AND id=$2", [memoryScope(alice), saved.id]);
    assert.deepEqual(tombstone.rows[0], { content: "", deleted: true, version: 3 });
  } finally {
    try {
      for (const context of [alice, bob]) {
        await pool.query("DELETE FROM public.support_memory_operations WHERE scope=$1", [memoryScope(context)]);
        await pool.query("DELETE FROM public.support_memories WHERE scope=$1", [memoryScope(context)]);
      }
    } finally { await memory.close(); await pool.end(); }
  }
});

test("真实 PostgreSQL：长期记忆注入容量有界，超限拒绝而不是静默覆盖旧记录", { timeout: 30_000 }, async () => {
  const memory = await createMemory();
  const pool = createDatabasePool();
  const context = localSupportContext(`integration-memory-${randomUUID()}`);
  try {
    for (let i = 0; i < 8; i++) {
      const content = `${i}:` + "x".repeat(988);
      const result = await memory.service.write(context, { change: { action: "save", content }, operationId: `op-${i}`, threadId: "t", messageId: `m-${i}`, sourceText: content, evidenceQuote: content });
      assert.equal(result.status, "saved");
    }
    const content = "新约束".repeat(100);
    const rejected = await memory.service.write(context, { change: { action: "save", content }, operationId: "over", threadId: "t", messageId: "m", sourceText: content, evidenceQuote: content });
    assert.deepEqual(rejected, { status: "rejected", code: "CAPACITY" });
    assert.equal((await memory.service.list(context)).length, 8);
  } finally {
    try {
      await pool.query("DELETE FROM public.support_memory_operations WHERE scope=$1", [memoryScope(context)]);
      await pool.query("DELETE FROM public.support_memories WHERE scope=$1", [memoryScope(context)]);
    } finally { await memory.close(); await pool.end(); }
  }
});

for (const kind of ["model", "tool"]) {
  test(`真实 PostgreSQL：${kind} 会话预算跨进程保留且超限不执行`, { timeout: 60_000 }, async () => {
    const saver = await createCheckpointer();
    const threadId = `integration-limits-${kind}-${randomUUID()}`;
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    try {
      for (const phase of ["seed", "check"]) {
        const { stdout } = await exec(process.execPath, ["--import", "tsx", "--import", "./tests/setup.ts", "tests/fixtures/limits-worker.ts", kind, phase, threadId], { cwd, timeout: 25_000 });
        assert.match(stdout, /limits-worker-ok/);
      }
    } finally {
      try { await saver.deleteThread(threadId); }
      finally { await saver.end(); }
    }
  });
}

test("真实 PostgreSQL：PII 在首个输入 checkpoint 前脱敏，重试不重复提交用户消息", { timeout: 25_000 }, async () => {
  const saver = await createCheckpointer();
  const threadId = `integration-pii-${randomUUID()}`;
  const model = fakeModel().respond(Object.assign(new Error("临时服务错误"), { status: 503 }))
    .respond((messages) => {
      assert.equal(messages.at(-1)?.text, "联系 [REDACTED_EMAIL] [REDACTED_CN_PHONE]");
      return new AIMessage("请说明问题");
    });
  try {
    const agent = createSupportAgent(model, saver);
    await runSupportAgent(agent, "联系 user@example.com 13800138000", undefined, threadId);
    let checkpoints = 0;
    for await (const entry of saver.list({ configurable: { thread_id: threadId } })) {
      checkpoints++;
      assert.doesNotMatch(JSON.stringify(entry.checkpoint), /user@example\.com|13800138000/);
    }
    assert.ok(checkpoints > 0);
    const latest = await agent.graph.getState({ configurable: { thread_id: threadId } });
    assert.deepEqual(latest.values.messages.map((m: { type: string }) => m.type), ["human", "ai"]);
    assert.equal(model.calls.length, 2);
  } finally {
    try { await saver.deleteThread(threadId); }
    finally { await saver.end(); }
  }
});

test("真实 PostgreSQL：进程退出后新进程恢复已完成会话，不调用真实模型", { timeout: 60_000 }, async () => {
  const saver = await createCheckpointer();
  const threadId = `integration-${randomUUID()}`;
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  try {
    for (const phase of ["write", "read"]) {
      const { stdout } = await exec(process.execPath, ["--import", "tsx", "tests/fixtures/postgres-worker.ts", phase, threadId], {
        cwd, timeout: 25_000,
      });
      assert.match(stdout, /checkpoint-worker-ok/);
    }
    assert.ok(await saver.getTuple({ configurable: { thread_id: threadId } }));
  } finally {
    // 仅清除此测试创建的随机 thread，不清空共享 schema 或其他用户历史。
    try { await saver.deleteThread(threadId); }
    finally { await saver.end(); }
  }
});

test("数据库连接失败时安全报错，不自动切回内存", { timeout: 15_000 }, async () => {
  await assert.rejects(createCheckpointer("postgresql://test:private-test-secret@127.0.0.1:1/unreachable"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /数据库初始化失败/);
    assert.doesNotMatch(error.message, /private-test-secret|postgresql:\/\//);
    return true;
  });
});

test("checkpoint 读取失败时终止流程，CLI 不暴露数据库原始错误", { timeout: 15_000 }, async () => {
  const saver = await createCheckpointer();
  await saver.end(); // 模拟启动后存储失效，不破坏真实表或其他会话。
  const model = fakeModel().respond(new AIMessage("不应返回的回答"));
  const lines: string[] = [];
  await assert.rejects(runSupportCli(createSupportAgent(model, saver), "测试读失败", (line) => lines.push(line), false, `integration-${randomUUID()}`));
  assert.equal(model.calls.length, 0);
  assert.match(lines.join(""), /\[失败\]/);
  assert.doesNotMatch(lines.join(""), /\[完成\]|postgresql:\/\//);
});

test("摘要后的状态跨进程恢复，旧 checkpoint 仍保留原文", { timeout: 60_000 }, async () => {
  const saver = await createCheckpointer();
  const threadId = `integration-summary-${randomUUID()}`;
  try {
    for (const phase of ["write", "read"]) {
      const { stdout } = await exec(process.execPath, ["--import", "tsx", "tests/fixtures/summary-worker.ts", phase, threadId], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 25_000,
      });
      assert.match(stdout, /summary-worker-ok/);
    }
    let hasOriginal = false;
    let hasSummary = false;
    for await (const entry of saver.list({ configurable: { thread_id: threadId } })) {
      const text = JSON.stringify(entry.checkpoint.channel_values.messages);
      hasOriginal ||= text.includes("原始问题使用桌面版。");
      hasSummary ||= text.includes('"lc_source":"summarization"');
    }
    assert.ok(hasOriginal && hasSummary);
  } finally {
    try { await saver.deleteThread(threadId); }
    finally { await saver.end(); }
  }
});
