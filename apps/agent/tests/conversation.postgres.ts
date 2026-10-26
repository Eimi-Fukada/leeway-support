import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AIMessage, fakeModel } from "langchain";
import { createDatabasePool } from "../src/config/database.ts";
import { createCheckpointer } from "../src/config/checkpoint.ts";
import { createSupportAgent } from "../src/agent/agent.ts";
import { runSupportAgent } from "../src/agent/run.ts";
import { InformationService } from "../src/interactions/service.ts";
import { ConversationService } from "../src/conversations/service.ts";
import { conversationSnapshot, requestHash } from "../src/conversations/execution.ts";
import { localSupportContext, checkpointThreadId, memoryScope } from "../src/support-context.ts";

async function environment() {
  const pool = createDatabasePool(); const saver = await createCheckpointer();
  const context = localSupportContext(`integration-history-${randomUUID()}`);
  const threadId = randomUUID(); const thread = checkpointThreadId(threadId, context); const scope = memoryScope(context);
  const information = new InformationService(pool); await information.setup();
  const conversation = new ConversationService(pool); await conversation.setup();
  return { pool, saver, context, threadId, thread, scope, information, conversation,
    close: async () => {
      try {
        await saver.deleteThread(thread);
        for (const table of ["support_conversation_messages", "support_conversation_requests", "support_information_forms"]) await pool.query(`DELETE FROM public.${table} WHERE scope=$1`, [scope]);
      } finally { await saver.end(); await pool.end(); }
    } };
}

test("真实 PostgreSQL：普通请求幂等、历史归档和新仓储重放结果，身份隔离", async () => {
  const env = await environment();
  try {
    const model = fakeModel().respond(new AIMessage("完整客服回答"));
    const agent = createSupportAgent(model, env.saver, {}, {}, undefined, env.information);
    const request = { service: env.information, conversation: env.conversation, requestId: "stable" };
    const first = await runSupportAgent(agent, "联系 eval@example.com，我有问题", undefined, env.threadId, env.context, request);
    const restarted = new ConversationService(env.pool);
    assert.deepEqual(await runSupportAgent(agent, "联系 eval@example.com，我有问题", undefined, env.threadId, env.context, { ...request, conversation: restarted }), first);
    // 原始载荷不同，即使 PII 清理后相同，也不能冒充同一请求。
    await assert.rejects(runSupportAgent(agent, "联系 other@example.com，我有问题", undefined, env.threadId, env.context, request), /不同内容/);
    const snapshot = await env.information.withThread(env.scope, env.thread, () => conversationSnapshot(agent, env.information, restarted, env.scope, env.thread, true));
    assert.equal(snapshot.messages.length, 2); assert.equal(snapshot.requests.length, 1);
    assert.match(snapshot.messages[0]!.content, /REDACTED_EMAIL/);
    assert.doesNotMatch(JSON.stringify(snapshot), /eval@example\.com|payloadHash|tool_call|systemPrompt/);
    assert.equal(snapshot.status, "completed"); assert.equal(snapshot.historyComplete, true);
    const other = localSupportContext("other");
    assert.equal((await conversationSnapshot(agent, env.information, restarted, memoryScope(other), checkpointThreadId(env.threadId, other), true)).status, "empty");
    assert.equal(model.calls.length, 1);
  } finally { await env.close(); }
});

test("真实 PostgreSQL：并发重复请求只有一次执行，锁持有期间查询为 running", { timeout: 15_000 }, async () => {
  const env = await environment();
  try {
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const originalStart = env.conversation.start.bind(env.conversation);
    env.conversation.start = async (...args) => { await originalStart(...args); started(); await gate; };
    const model = fakeModel().respond(new AIMessage("一次结果"));
    const agent = createSupportAgent(model, env.saver, {}, {}, undefined, env.information);
    const request = { service: env.information, conversation: env.conversation, requestId: "concurrent" };
    const running = runSupportAgent(agent, "问题", undefined, env.threadId, env.context, request);
    try {
      await entered;
      await assert.rejects(runSupportAgent(agent, "问题", undefined, env.threadId, env.context, request), /正在处理/);
      const snapshot = await conversationSnapshot(agent, env.information, env.conversation, env.scope, env.thread, false);
      assert.equal(snapshot.status, "running"); assert.equal(snapshot.messages.length, 1);
    } finally { release(); }
    const first = await running;
    assert.deepEqual(await runSupportAgent(agent, "问题", undefined, env.threadId, env.context, request), first);
    assert.equal(model.calls.length, 1);
    assert.equal((await env.conversation.history(env.scope, env.thread)).messages.length, 2);
  } finally { await env.close(); }
});

test("真实 PostgreSQL：崩溃接收窗口没有证据时保留 unknown，零模型调用", async () => {
  const env = await environment();
  try {
    await env.conversation.start(env.scope, env.thread, "lost", randomUUID(), requestHash("原问题"), "原问题");
    const model = fakeModel(); const agent = createSupportAgent(model, env.saver, {}, {}, undefined, env.information);
    const snapshot = await env.information.withThread(env.scope, env.thread, () => conversationSnapshot(agent, env.information, env.conversation, env.scope, env.thread, true));
    assert.equal(snapshot.status, "unknown");
    await assert.rejects(runSupportAgent(agent, "原问题", undefined, env.threadId, env.context, { service: env.information, conversation: env.conversation, requestId: "lost" }), /结果未知/);
    assert.equal(model.calls.length, 0);
  } finally { await env.close(); }
});

test("真实 PostgreSQL：表单提交已完成但结果账本写失败，只读核对修复，不重复恢复", async () => {
  const env = await environment();
  try {
    const model = fakeModel().respond(new AIMessage({ content: "", tool_calls: [{ name: "request_information", id: "form", type: "tool_call", args: {
      title: "资料", description: "错误是什么", fields: [{ key: "error", label: "错误", type: "text", required: true }],
    } }] })).respond(new AIMessage("收到错误码"));
    const agent = createSupportAgent(model, env.saver, {}, {}, undefined, env.information);
    const first = await runSupportAgent(agent, "问题", undefined, env.threadId, env.context, { service: env.information, conversation: env.conversation, requestId: "ask" });
    const form = first.information!;
    const submission = { formId: form.formId, formVersion: 1 as const, interruptId: form.interruptId!, submissionId: randomUUID(), answers: { error: "ERR-HISTORY" } };
    const record = env.information.record.bind(env.information);
    env.information.record = async () => { throw new Error("result store failed"); };
    await assert.rejects(runSupportAgent(agent, "", undefined, env.threadId, env.context, { service: env.information, conversation: env.conversation, submission }));
    env.information.record = record;
    const result = await runSupportAgent(agent, "", undefined, env.threadId, env.context, { service: env.information, conversation: env.conversation, submission });
    assert.equal(result.answer, "收到错误码");
    assert.ok(await env.information.replay(env.scope, env.thread, submission));
    const history = await env.conversation.history(env.scope, env.thread);
    assert.deepEqual(history.messages.map((message) => message.role), ["user", "user", "assistant"]);
    assert.match(history.messages[1]!.content, /ERR-HISTORY/);
    assert.equal(model.calls.length, 2);
  } finally { await env.close(); }
});

test("真实 PostgreSQL：进程重启后由 checkpoint 完成回执补齐消息档案，重放不请求模型", { timeout: 60_000 }, async () => {
  const env = await environment();
  try {
    for (const phase of ["execute", "reconcile"]) {
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--import", "./tests/setup.ts", "tests/fixtures/conversation-worker.ts", phase, env.context.subject.id, env.threadId], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 25_000,
      });
      assert.match(stdout, /conversation-worker-ok/);
    }
    assert.equal((await env.conversation.history(env.scope, env.thread)).messages.length, 2);
  } finally { await env.close(); }
});

test("真实 PostgreSQL：默认五连接池同时持有五个会话锁，内部查询仍能全部完成", { timeout: 15_000 }, async () => {
  const pool = createDatabasePool();
  const information = new InformationService(pool);
  let entered = 0; let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  try {
    assert.equal(pool.options.max, 5);
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => information.withThread(
      `integration-lock-${process.pid}`, `thread-${index}`, async () => {
        entered++; if (entered === 5) release(); await ready;
        const result = await pool.query("SELECT 1 AS value");
        return result.rows[0].value;
      },
    )));
    assert.deepEqual(results.map((entry) => entry.status), Array(5).fill("fulfilled"));
    assert.ok(results.every((entry) => entry.status === "fulfilled" && entry.value === 1));
  } finally { await pool.end(); }
});

test("真实 PostgreSQL：锁连接并发按业务池共享限额，饱和时拒绝并在结束后释放", { timeout: 15_000 }, async () => {
  const pool = createDatabasePool();
  const first = new InformationService(pool); const second = new InformationService(pool);
  let entered = 0; let release!: () => void; let allEntered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { allEntered = resolve; });
  const jobs = Array.from({ length: 5 }, (_, index) => first.withThread(`integration-lock-limit-${process.pid}`, `thread-${index}`, async () => {
    entered++; if (entered === 5) allEntered(); await gate;
    return pool.query("SELECT 1");
  }));
  try {
    await ready;
    await assert.rejects(second.withThread("integration-lock-limit", "sixth", async () => "not-run"), /并发已满/);
  } finally { release(); }
  try {
    const results = await Promise.allSettled(jobs);
    assert.ok(results.every((entry) => entry.status === "fulfilled"));
    assert.equal(await second.withThread("integration-lock-limit", "after", async () => 1), 1);
  } finally { await pool.end(); }
});

test("真实 PostgreSQL：恢复请求准入后崩溃，保存 kind=resume 并拒绝旧暂停伪回执", async () => {
  const env = await environment();
  try {
    const model = fakeModel().respond(new AIMessage({ content: "", tool_calls: [{ name: "request_information", id: "ask", type: "tool_call", args: {
      title: "资料", description: "系统信息", fields: [{ key: "os", label: "系统", type: "text", required: true }],
    } }] }));
    const agent = createSupportAgent(model, env.saver, {}, {}, undefined, env.information);
    const first = await runSupportAgent(agent, "问题", undefined, env.threadId, env.context, { service: env.information, conversation: env.conversation, requestId: "initial" });
    const form = first.information!;
    const submission = { formId: form.formId, formVersion: 1 as const, interruptId: form.interruptId!, submissionId: randomUUID(), answers: { os: "Windows" } };
    const originalStart = env.conversation.start.bind(env.conversation);
    env.conversation.start = async (...args) => { await originalStart(...args); throw new Error("crash before resume"); };
    await assert.rejects(runSupportAgent(agent, "", undefined, env.threadId, env.context, { service: env.information, conversation: env.conversation, submission }), /crash before resume/);
    const snapshot = await env.information.withThread(env.scope, env.thread, () => conversationSnapshot(agent, env.information, env.conversation, env.scope, env.thread, true));
    assert.equal(snapshot.status, "unknown");
    const record = await env.conversation.find(env.scope, env.thread, submission.submissionId);
    assert.equal(record!.kind, "resume"); assert.equal(record!.status, "unknown");
    await assert.rejects(runSupportAgent(agent, "", undefined, env.threadId, env.context, { service: env.information, conversation: env.conversation, submission }), /结果未知/);
    const state = await env.pool.query("SELECT status,submission_id FROM public.support_information_forms WHERE id=$1", [form.formId]);
    assert.deepEqual(state.rows[0], { status: "pending", submission_id: null });
    assert.equal(model.calls.length, 1);
  } finally { await env.close(); }
});
