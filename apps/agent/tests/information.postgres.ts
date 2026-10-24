import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AIMessage, fakeModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { createDatabasePool } from "../src/config/database.ts";
import { InformationService } from "../src/interactions/service.ts";
import { createSupportAgent } from "../src/agent/agent.ts";
import { runSupportAgent } from "../src/agent/run.ts";
import { localSupportContext, memoryScope, checkpointThreadId } from "../src/support-context.ts";

const spec = { title: "补充运行环境", description: "请选择实际环境。", fields: [
  { key: "environment", type: "select" as const, label: "使用环境", required: true,
    options: [{ value: "desktop", label: "桌面端" }, { value: "browser", label: "浏览器" }] },
] };
const call = () => new AIMessage({ content: "", tool_calls: [{ name: "request_information", args: spec, id: randomUUID(), type: "tool_call" }] });

test("真实 PostgreSQL：暂停后原任务恢复、重复提交重放、归属与修改拒绝", async () => {
  const pool = createDatabasePool();
  const service = new InformationService(pool);
  const context = localSupportContext(`integration-form-${randomUUID()}`);
  const scope = memoryScope(context);
  const thread = randomUUID();
  try {
    await service.setup();
    const model = fakeModel().respond(call()).respond((messages) => {
      assert.equal(messages.at(-1)!.type, "tool");
      assert.match(messages.at(-1)!.text, /浏览器/);
      assert.equal(messages.filter((message) => message.type === "human").length, 1);
      return new AIMessage("收到，我会按浏览器环境继续排查。");
    });
    const agent = createSupportAgent(model, new MemorySaver(), {}, {}, undefined, service);
    const first = await runSupportAgent(agent, "导出失败", undefined, thread, context, { service });
    assert.ok(first.information?.interruptId);
    assert.equal(first.status, "waiting_for_input");
    assert.equal(model.calls.length, 1);
    const form = first.information;
    const submission = { formId: form.formId, formVersion: 1 as const, interruptId: form.interruptId!, submissionId: randomUUID(), answers: { environment: "browser" } };
    const savedThread = checkpointThreadId(thread, context);
    await assert.rejects(service.accept("other-user", savedThread, submission), /表单不可用/);
    await assert.rejects(runSupportAgent(agent, "", undefined, thread, localSupportContext("another-user"), { service, submission }), /表单不可用/);
    await assert.rejects(service.accept(scope, savedThread, { ...submission, answers: { environment: "invented" } }), /选项无效/);
    await assert.rejects(runSupportAgent(agent, "", undefined, thread, context, { service, submission: { ...submission, interruptId: "stale" } }), /暂停点/);
    const next = await runSupportAgent(agent, "", undefined, thread, context, { service, submission });
    assert.equal(next.status, "completed");
    assert.equal(next.runId, first.runId);
    assert.match(next.answer, /浏览器/);
    assert.equal(model.calls.length, 2);
    const afterRestart = new InformationService(pool);
    const replay = await runSupportAgent(agent, "", undefined, thread, context, { service: afterRestart, submission });
    assert.deepEqual(replay, next);
    assert.equal(model.calls.length, 2);
    assert.equal((await service.get(scope, savedThread, form.formId)).status, "submitted");
    await assert.rejects(service.accept(scope, savedThread, { ...submission, answers: { environment: "desktop" } }), /不能重复修改/);
    const rows = await pool.query("SELECT count(*)::int AS count FROM public.support_information_forms WHERE scope=$1", [scope]);
    assert.equal(rows.rows[0].count, 1);
    const state = await agent.graph.getState({ configurable: { thread_id: savedThread } });
    assert.equal(state.values.threadToolCallCount.__all__, 1);
    assert.deepEqual(state.values.runToolCallCount, {});
  } finally {
    await pool.query("DELETE FROM public.support_information_forms WHERE scope=$1", [scope]);
    await pool.end();
  }
});

test("真实 PostgreSQL：创建幂等、过期/旧表单/未确认提交拒绝，等待期间释放会话锁", async () => {
  const pool = createDatabasePool();
  const service = new InformationService(pool);
  const scope = `integration-form-${randomUUID()}`;
  const thread = randomUUID();
  try {
    await service.setup();
    const run = randomUUID();
    const form = await service.create(scope, thread, run, "call", spec);
    assert.deepEqual(await service.create(scope, thread, run, "call", spec), form);
    await assert.rejects(service.create(scope, thread, run, "another", spec), /只允许/);
    await service.wait(scope, thread, run, form.formId, "interrupt-test");
    await pool.query("UPDATE public.support_information_forms SET expires_at=now()-interval '1 minute' WHERE id=$1", [form.formId]);
    assert.equal((await service.get(scope, thread, form.formId)).status, "invalidated");
    await assert.rejects(service.accept(scope, thread, { formId: form.formId, formVersion: 1, interruptId: "interrupt-test", submissionId: randomUUID(), answers: { environment: "browser" } }), /失效/);
    const activeRun = randomUUID();
    const active = await service.create(scope, thread, activeRun, "new-call", spec);
    await service.wait(scope, thread, activeRun, active.formId, "interrupt-active");
    const submission = { formId: active.formId, formVersion: 1 as const, interruptId: "interrupt-active", submissionId: randomUUID(), answers: { environment: "browser" } };
    await service.accept(scope, thread, submission);
    await assert.rejects(service.replay(scope, thread, submission), /执行结果未确认/);
    await service.withThread(scope, thread, async () => {
      await assert.rejects(service.withThread(scope, thread, async () => "must-not-run"), /会话正在处理/);
    });
    await assert.rejects(service.withThread(scope, thread, async () => { throw new Error("模拟异常"); }), /模拟异常/);
    assert.equal(await service.withThread(scope, thread, async () => "lock-released"), "lock-released");
    const oldRun = randomUUID();
    const old = await service.create(scope, thread, oldRun, "old", spec);
    await service.wait(scope, thread, oldRun, old.formId, "interrupt-old");
    await service.begin(scope, thread);
    assert.equal((await service.get(scope, thread, old.formId)).status, "invalidated");
  } finally {
    await pool.query("DELETE FROM public.support_information_forms WHERE scope=$1", [scope]);
    await pool.end();
  }
});

test("真实 PostgreSQL：服务进程退出后从暂停 checkpoint 恢复，表单不重复且预算不清零", { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  const user = `integration-form-${randomUUID()}`;
  const thread = randomUUID();
  const scope = memoryScope(localSupportContext(user));
  try {
    for (const phase of ["pause", "resume"]) {
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--import", "./tests/setup.ts", "tests/fixtures/information-worker.ts", phase, user, thread], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 25_000,
      });
      assert.match(stdout, /information-worker-ok/);
    }
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.support_information_forms WHERE scope=$1", [scope])).rows[0].count, 1);
  } finally {
    await pool.query("DELETE FROM public.support_information_forms WHERE scope=$1", [scope]);
    await pool.end();
    const { createCheckpointer } = await import("../src/config/checkpoint.ts");
    const saver = await createCheckpointer();
    try { await saver.deleteThread(checkpointThreadId(thread, localSupportContext(user))); }
    finally { await saver.end(); }
  }
});
