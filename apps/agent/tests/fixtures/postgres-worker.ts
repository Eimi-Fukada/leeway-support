import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { AIMessage, fakeModel } from "langchain";
import { createCheckpointer } from "../../src/checkpoint.ts";
import { createSupportAgent } from "../../src/agent.ts";
import { chat } from "../../src/chat.ts";

async function main() {
  const [phase, threadId] = process.argv.slice(2);
  assert.ok(threadId?.startsWith("integration-"));
  const saver = await createCheckpointer();
  try {
    const model = phase === "write"
      ? fakeModel().respond(new AIMessage("已记录测试信息"))
      : fakeModel().respond((messages) => {
          assert.deepEqual(messages.slice(1).map((m) => m.text), [
            "测试信息：蓝松", "已记录测试信息", "之前的测试信息是什么？",
          ]);
          return new AIMessage("蓝松");
        });
    const agent = createSupportAgent(model, saver);
    const question = phase === "write" ? "测试信息：蓝松" : "之前的测试信息是什么？";
    // 写进程新建指定 ID；读进程走产品实际恢复入口。
    if (phase === "write") {
      await agent.invoke({ messages: [{ role: "user", content: question }] }, {
        configurable: { thread_id: threadId },
      });
    } else {
      await chat(agent, Readable.from([question, "/exit"]), () => {}, false, threadId);
    }
    assert.equal(model.calls.length, 1);
    console.log("checkpoint-worker-ok");
  } finally {
    await saver.end();
  }
}

main().catch(() => {
  console.error("checkpoint-worker-failed");
  process.exitCode = 1;
});
