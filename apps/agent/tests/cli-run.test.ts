import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, AIMessageChunk, fakeModel } from "langchain";
import { FakeBuiltModel } from "@langchain/core/testing";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { createSupportAgent } from "../src/agent.ts";
import { runSupportCli } from "../src/cli-run.ts";

// 控制真正的模型流边界，证明主路径在模型结束前已经展示片段。
class StreamingModel extends FakeBuiltModel {
  attempts = 0;
  afterFirst: () => void | Promise<void> = () => {};
  failure?: Error;

  override bindTools() { return this; }

  override async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ) {
    this.attempts++;
    for (const [index, text] of ["你好", "，客服回答"].entries()) {
      const chunk = new ChatGenerationChunk({ text, message: new AIMessageChunk(text) });
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk });
      yield chunk;
      if (index === 0) {
        await this.afterFirst();
        if (this.failure) throw this.failure;
      }
    }
  }
}

test("正常客服入口在流结束前展示片段，同一次执行返回最终回答且不重复打印", { timeout: 3000 }, async () => {
  const model = new StreamingModel();
  const output: string[] = [];
  let markObserved!: () => void;
  const observed = new Promise<void>((resolve) => { markObserved = resolve; });
  model.afterFirst = async () => {
    // Graph 异步转发模型事件；等待消费者确认片段到达，再允许模型继续。
    await observed;
    assert.equal(output.join(""), "[客服] 你好");
    assert.doesNotMatch(output.join(""), /完成/);
  };

  const result = await runSupportCli(createSupportAgent(model), "测试", (text) => {
    output.push(text);
    if (text === "你好") markObserved();
  });

  assert.equal(result.answer, "你好，客服回答");
  assert.ok(result.elapsedMs >= 0);
  assert.equal(model.attempts, 1);
  assert.match(output.join(""), /^\[客服\] 你好，客服回答\n\[完成\] 耗时 \d+ ms\n$/);
});

test("正常客服入口断流后拒绝返回成功，不输出敏感错误", async () => {
  const model = new StreamingModel();
  const failure = new Error("原始供应商敏感错误");
  model.failure = failure;
  const output: string[] = [];

  await assert.rejects(
    runSupportCli(createSupportAgent(model), "测试", (text) => output.push(text)),
    (error: unknown) => error === failure,
  );
  assert.equal(model.attempts, 1);
  assert.match(output.join(""), /^\[客服\] 你好\n\[失败\]/);
  assert.doesNotMatch(output.join(""), /完成\]|最终回答|原始供应商敏感错误/);
});

test("最终状态无有效文本时，即使流正常结束也报告失败", async () => {
  const model = fakeModel().respond(new AIMessage("   "));
  const output: string[] = [];
  await assert.rejects(
    runSupportCli(createSupportAgent(model), "测试", (text) => output.push(text)),
    /模型未返回有效文本回答/,
  );
  assert.equal(model.calls.length, 1);
  assert.match(output.join(""), /\[失败\]/);
  assert.doesNotMatch(output.join(""), /\[完成\]/);
});

test("普通展示只消费文本，正确传递输入并返回结构化执行结果", async () => {
  const model = fakeModel().respond((messages) => {
    assert.equal(messages.at(-1)?.text, "本轮用户输入");
    assert.match(messages[0]?.text ?? "", /Leeway Support/);
    return new AIMessage({
      content: [
        { type: "reasoning", reasoning: "不应展示的推理" },
        { type: "text", text: "客服答案" },
      ],
      response_metadata: { internalMarker: "不应展示的元数据" },
    });
  });
  const output: string[] = [];
  const result = await runSupportCli(createSupportAgent(model), "本轮用户输入", (text) => output.push(text));
  assert.equal(result.answer, "客服答案");
  assert.equal(model.calls.length, 1);
  assert.doesNotMatch(output.join(""), /不应展示|节点更新|文本片段|最终回答/);
});
