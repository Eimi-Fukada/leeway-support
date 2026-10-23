import assert from "node:assert/strict";
import { AIMessage, createAgent, fakeModel, tool } from "langchain";
import { createCheckpointer } from "../../src/config/checkpoint.ts";
import { createSupportAgent } from "../../src/agent/agent.ts";
import { runSupportAgent } from "../../src/agent/run.ts";
import { createModelCallLimitMiddleware } from "../../src/agent/middleware/model-call-limit.ts";
import { createToolCallLimitMiddleware } from "../../src/agent/middleware/tool-call-limit.ts";

async function main() {
  const [kind, phase, threadId] = process.argv.slice(2);
  if (!["model", "tool"].includes(kind ?? "") || !["seed", "check"].includes(phase ?? "") || !threadId?.startsWith("integration-limits-")) {
    throw new Error("invalid-fixture-input");
  }
  const saver = await createCheckpointer();
  try {
    if (kind === "model") {
      const model = fakeModel().respond(new AIMessage("完成"));
      const agent = createSupportAgent(model, saver, {}, { model: { runLimit: 1, threadLimit: 1 } });
      if (phase === "seed") await runSupportAgent(agent, "第一轮", undefined, threadId);
      else {
        await assert.rejects(runSupportAgent(agent, "超限轮", undefined, threadId), /Model call limits exceeded/);
        assert.equal(model.calls.length, 0);
      }
    } else {
      let executions = 0;
      const fixtureTool = tool(async () => { executions++; return "result"; }, {
        name: "fixture_read", description: "无副作用测试工具", schema: { type: "object", properties: {} },
      });
      const model = fakeModel().respond(new AIMessage({ content: "", tool_calls: [{ name: "fixture_read", args: {}, id: `call-${phase}`, type: "tool_call" }] }))
        .respond(new AIMessage("完成"));
      const agent = createAgent({ model, tools: [fixtureTool], checkpointer: saver, middleware: [
        createModelCallLimitMiddleware(), createToolCallLimitMiddleware({ runLimit: 1, threadLimit: 1 }),
      ] });
      const config = { configurable: { thread_id: threadId } };
      if (phase === "seed") {
        await agent.invoke({ messages: [{ role: "user", content: "第一轮" }] }, config);
        assert.equal(executions, 1);
      } else {
        await assert.rejects(agent.invoke({ messages: [{ role: "user", content: "超限轮" }] }, config), /Tool call limit reached/);
        assert.equal(executions, 0);
        assert.equal(model.calls.length, 1);
      }
    }
    console.log("limits-worker-ok");
  } finally { await saver.end(); }
}

main().catch(() => { console.error("limits-worker-failed"); process.exitCode = 1; });
