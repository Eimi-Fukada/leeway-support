import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
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

test("真实 PostgreSQL：表单提交后继续原会话、重复提交重放结果、归属与修改拒绝", async () => {
  const pool = createDatabasePool();
  const service = new InformationService(pool);
  const context = localSupportContext(`integration-form-${randomUUID()}`);
  const scope = memoryScope(context);
  const thread = randomUUID();
  try {
    await service.setup();
    const model = fakeModel().respond(call()).respond(new AIMessage("请补充环境")) .respond((messages) => {
      assert.match(messages.at(-1)!.text, /浏览器/);
      assert.ok(messages.some((message) => message.type === "human" && message.text === "导出失败"));
      return new AIMessage("收到，我会按浏览器环境继续排查。");
    });
    const agent = createSupportAgent(model, new MemorySaver(), {}, {}, undefined, service);
    const first = await runSupportAgent(agent, "导出失败", undefined, thread, context, { service });
    assert.ok(first.information);
    const form = first.information;
    assert.equal(form.status, "pending");
    const submission = { formId: form.formId, formVersion: 1 as const, submissionId: randomUUID(), answers: { environment: "browser" } };
    const savedThread = checkpointThreadId(thread, context);
    await assert.rejects(service.accept("other-user", savedThread, submission), /表单不可用/);
    await assert.rejects(service.accept(scope, savedThread, { ...submission, answers: { environment: "invented" } }), /选项无效/);
    const next = await runSupportAgent(agent, "已提交补充信息", undefined, thread, context, { service, submission });
    assert.match(next.answer, /浏览器/);
    assert.equal(model.calls.length, 3);
    // 重新创建仓储对象后，幂等结果依旧可读，和内存中的 UI/Agent 无关。
    const afterRestart = new InformationService(pool);
    const replay = await runSupportAgent(agent, "重复提交", undefined, thread, context, { service: afterRestart, submission });
    assert.deepEqual(replay, next);
    assert.equal(model.calls.length, 3);
    assert.equal((await service.get(scope, savedThread, form.formId)).status, "submitted");
    await assert.rejects(service.accept(scope, savedThread, { ...submission, answers: { environment: "desktop" } }), /不能重复修改/);
    const rows = await pool.query("SELECT spec,submission_hash,result FROM public.support_information_forms WHERE scope=$1", [scope]);
    assert.ok(rows.rows[0].submission_hash && rows.rows[0].result);
    assert.equal("answers" in rows.rows[0], false);
  } finally {
    await pool.query("DELETE FROM public.support_information_forms WHERE scope=$1", [scope]);
    await pool.end();
  }
});

test("真实 PostgreSQL：过期、旧表单、未确认执行、会话并发锁与创建失败", async () => {
  const pool = createDatabasePool();
  const service = new InformationService(pool);
  const scope = `integration-form-${randomUUID()}`;
  const thread = randomUUID();
  try {
    await service.setup();
    const run = randomUUID();
    const form = await service.create(scope, thread, run, "call", spec);
    assert.equal(form.status, "draft");
    await assert.rejects(service.accept(scope, thread, { formId: form.formId, formVersion: 1, submissionId: randomUUID(), answers: { environment: "browser" } }), /失效/);
    await assert.rejects(service.create(scope, thread, run, "another", spec), /一轮只允许/);
    await service.finish(scope, thread, run, true);
    await pool.query("UPDATE public.support_information_forms SET expires_at=now()-interval '1 minute' WHERE id=$1", [form.formId]);
    assert.equal((await service.get(scope, thread, form.formId)).status, "invalidated");
    await assert.rejects(service.accept(scope, thread, { formId: form.formId, formVersion: 1, submissionId: randomUUID(), answers: { environment: "browser" } }), /失效/);
    const activeRun = randomUUID();
    const active = await service.create(scope, thread, activeRun, "new-call", spec);
    await service.finish(scope, thread, activeRun, true);
    const submission = { formId: active.formId, formVersion: 1 as const, submissionId: randomUUID(), answers: { environment: "browser" } };
    await service.accept(scope, thread, submission);
    await assert.rejects(service.accept(scope, thread, submission), /执行结果未确认/);
    await service.withThread(scope, thread, async () => {
      await assert.rejects(service.withThread(scope, thread, async () => "must-not-run"), /会话正在处理/);
    });
    await assert.rejects(service.withThread(scope, thread, async () => { throw new Error("模拟执行异常"); }), /模拟执行异常/);
    assert.equal(await service.withThread(scope, thread, async () => "lock-released"), "lock-released");
    const abandonedRun = randomUUID();
    const abandoned = await service.create(scope, thread, abandonedRun, "abandoned", spec);
    await service.finish(scope, thread, abandonedRun, false);
    assert.equal((await service.get(scope, thread, abandoned.formId)).status, "invalidated");
    const oldRun = randomUUID();
    const old = await service.create(scope, thread, oldRun, "old", spec);
    await service.finish(scope, thread, oldRun, true);
    await service.begin(scope, thread);
    assert.equal((await service.get(scope, thread, old.formId)).status, "invalidated");
  } finally {
    await pool.query("DELETE FROM public.support_information_forms WHERE scope=$1", [scope]);
    await pool.end();
  }
});
