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

const exec = promisify(execFile);

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
