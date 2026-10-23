import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AIMessage, fakeModel } from "langchain";
import { createCheckpointer } from "../../src/config/checkpoint.ts";
import { createMemory } from "../../src/config/memory.ts";
import { createSupportAgent } from "../../src/agent/agent.ts";
import { runSupportAgent } from "../../src/agent/run.ts";
import { checkpointThreadId, localSupportContext } from "../../src/support-context.ts";

async function main() {
  const [phase, user] = process.argv.slice(2);
  if (!["seed", "check"].includes(phase ?? "") || !user?.startsWith("integration-memory-")) throw new Error("invalid-fixture-input");
  const context = localSupportContext(user);
  const thread = randomUUID();
  const saver = await createCheckpointer();
  const memory = await createMemory();
  try {
    const fact = "公司环境不能访问外网";
    const model = phase === "seed" ? fakeModel().respond(new AIMessage({ content: "", tool_calls: [{
      name: "save_memory", args: { content: fact, evidenceQuote: fact }, id: "save", type: "tool_call",
    }] })).respond(new AIMessage("已保存")) : fakeModel().respond((messages) => {
      assert.match(messages[0]!.text, /公司环境不能访问外网/);
      assert.equal(messages.filter((message) => message.type === "human").length, 1);
      return new AIMessage("使用离线部署");
    });
    const agent = createSupportAgent(model, saver, {}, {}, memory.service);
    await runSupportAgent(agent, phase === "seed" ? fact : "如何部署？", undefined, thread, context);
    assert.equal(model.calls.length, phase === "seed" ? 2 : 1);
    console.log("long-term-worker-ok");
  } finally {
    try { await saver.deleteThread(checkpointThreadId(thread, context)); }
    finally { await memory.close(); await saver.end(); }
  }
}
main().catch(() => { console.error("long-term-worker-failed"); process.exitCode = 1; });
