import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AIMessage, fakeModel } from "langchain";
import { createCheckpointer } from "../../src/config/checkpoint.ts";
import { createDatabasePool } from "../../src/config/database.ts";
import { InformationService } from "../../src/interactions/service.ts";
import { createSupportAgent } from "../../src/agent/agent.ts";
import { runSupportAgent } from "../../src/agent/run.ts";
import { checkpointThreadId, localSupportContext } from "../../src/support-context.ts";

async function main() {
  const [phase, user, thread] = process.argv.slice(2);
  if (!user?.startsWith("integration-form-") || !thread || !["pause", "resume"].includes(phase ?? "")) throw new Error("invalid fixture");
  const saver = await createCheckpointer();
  const pool = createDatabasePool();
  try {
    const service = new InformationService(pool); await service.setup();
    const support = localSupportContext(user);
    const model = phase === "pause" ? fakeModel().respond(new AIMessage({ content: "", tool_calls: [{
      name: "request_information", id: "fixture-request", type: "tool_call", args: {
        title: "错误信息", description: "请填写错误信息", fields: [{ key: "error", type: "text", label: "错误", required: true }],
      },
    }] })) : fakeModel().respond((messages) => {
      assert.match(messages.at(-1)!.text, /ERR-TEST/);
      assert.equal(messages.at(-1)!.type, "tool");
      assert.equal(messages.filter((message) => message.type === "human").length, 1);
      return new AIMessage("收到 ERR-TEST");
    });
    const agent = createSupportAgent(model, saver, {}, {}, undefined, service);
    if (phase === "pause") {
      const result = await runSupportAgent(agent, "软件异常", undefined, thread, support, { service });
      assert.equal(result.status, "waiting_for_input");
      assert.equal(model.calls.length, 1);
      // 模拟 checkpoint 已落库，但应用尚未来得及发布等待表单就进程退出的窗口。
      await pool.query("UPDATE public.support_information_forms SET status='draft',interrupt_id=NULL WHERE id=$1", [result.information!.formId]);
    } else {
      const restored = await runSupportAgent(agent, "", undefined, thread, support, { service, restore: true });
      assert.equal(restored.status, "waiting_for_input");
      assert.equal(model.calls.length, 0);
      const form = restored.information!;
      const result = await runSupportAgent(agent, "", undefined, thread, support, { service, submission: {
        formId: form.formId, formVersion: 1, interruptId: form.interruptId!, submissionId: randomUUID(), answers: { error: "ERR-TEST" },
      } });
      assert.equal(result.status, "completed");
      assert.equal(result.runId, restored.runId);
      const state = await agent.graph.getState({ configurable: { thread_id: checkpointThreadId(thread, support) } });
      assert.equal(state.values.threadModelCallCount, 2);
      assert.equal(state.values.threadToolCallCount.__all__, 1);
      assert.equal(state.values.runModelCallCount, 0);
      assert.equal(model.calls.length, 1);
    }
    console.log("information-worker-ok");
  } finally { await saver.end(); await pool.end(); }
}
main().catch(() => { console.error("information-worker-failed"); process.exitCode = 1; });
