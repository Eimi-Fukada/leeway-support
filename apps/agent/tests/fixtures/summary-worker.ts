import assert from "node:assert/strict";
import { AIMessage, fakeModel } from "langchain";
import { createSupportAgent } from "../../src/agent/agent.ts";
import { runSupportAgent } from "../../src/agent/run.ts";
import { createCheckpointer } from "../../src/config/checkpoint.ts";

async function main() {
  const [phase, threadId] = process.argv.slice(2);
  assert.ok(threadId?.startsWith("integration-summary-"));
  const saver = await createCheckpointer();
  const summaryModel = fakeModel().respond(new AIMessage("用户使用桌面版，问题尚未解决。"));
  try {
    if (phase === "write") {
      const model = fakeModel().respond(new AIMessage("已了解")).respond(new AIMessage("请提供错误信息"));
      const agent = createSupportAgent(model, saver, { model: summaryModel, triggerTokens: 150, keepMessages: 2 });
      await runSupportAgent(agent, "原始问题使用桌面版。" + "背景".repeat(400), undefined, threadId);
      await runSupportAgent(agent, "还有问题", undefined, threadId);
      assert.equal(summaryModel.calls.length, 1);
    } else {
      const model = fakeModel().respond((messages) => {
        assert.ok(messages.some((message) => message.additional_kwargs.lc_source === "summarization"));
        assert.ok(!messages.some((message) => message.text.startsWith("原始问题使用桌面版。")));
        return new AIMessage("继续排查");
      });
      // 新进程使用日常阈值，恢复已经压缩的状态，不重复生成摘要。
      const agent = createSupportAgent(model, saver, { model: summaryModel });
      assert.equal((await runSupportAgent(agent, "继续", undefined, threadId)).answer, "继续排查");
      assert.equal(summaryModel.calls.length, 0);
    }
    console.log("summary-worker-ok");
  } finally {
    await saver.end();
  }
}

main().catch(() => {
  console.error("summary-worker-failed");
  process.exitCode = 1;
});
