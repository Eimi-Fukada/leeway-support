import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, AIMessageChunk, fakeModel } from "langchain";
import { FakeBuiltModel } from "@langchain/core/testing";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { createSupportAgent } from "../src/agent/agent.ts";
import { runSupportCli } from "../src/cli/chat.ts";

test("一次流式执行观察文本和节点，只在正常结束后报告最终回答", async () => {
  const model = fakeModel().respond(new AIMessage({
    content: [
      { type: "reasoning", reasoning: "不应展示的内部推理" },
      { type: "text", text: "流式流程测试结果" },
    ],
    response_metadata: { internalMarker: "不应展示的元数据" },
  }));
  const lines: string[] = [];

  await runSupportCli(createSupportAgent(model), "测试输入", (text) => lines.push(text.trimEnd()), true);

  assert.equal(model.calls.length, 1); // 不允许为获取最终结果重复请求模型。
  assert.ok(lines.some((line) => line.startsWith("[文本片段]")));
  assert.ok(lines.some((line) => line.startsWith("[节点更新]")));
  assert.equal(lines.at(-2), "[最终回答] 流式流程测试结果");
  assert.match(lines.at(-1) ?? "", /^\[完成\]/);
  assert.doesNotMatch(lines.join("\n"), /不应展示|\[失败\]/);
});

test("模型错误向上传播，观察输出不泄露原始错误且不报告成功", async () => {
  const failure = new Error("原始供应商敏感错误");
  const model = fakeModel().respond(failure);
  const lines: string[] = [];

  await assert.rejects(
    runSupportCli(createSupportAgent(model), "测试失败", (text) => lines.push(text.trimEnd()), true),
    (error: unknown) => error === failure,
  );

  assert.equal(model.calls.length, 1);
  assert.match(lines.at(-1) ?? "", /^\[失败\]/);
  assert.doesNotMatch(lines.join("\n"), /原始供应商敏感错误|\[最终回答\]|\[完成\]/);
});

test("已有文本片段但随后断流时，不将半成品作为最终结果", async () => {
  const failure = new Error("模拟流式连接中断");
  // fakeModel 的普通 respond 不产生“先输出后抛错”的流，测试中单独覆盖此行为。
  class InterruptedModel extends FakeBuiltModel {
    // 当前没有工具；保留子类实例，避免默认 bindTools 克隆后丢失断流行为。
    override bindTools() {
      return this;
    }

    override async *_streamResponseChunks(
      _messages: BaseMessage[],
      _options: this["ParsedCallOptions"],
      runManager?: CallbackManagerForLLMRun,
    ) {
      const chunk = new ChatGenerationChunk({
        text: "尚未完整的回答",
        message: new AIMessageChunk("尚未完整的回答"),
      });
      // 和真实流式模型一样通过 callback 发布片段，Graph messages 模式才能观察到它。
      await runManager?.handleLLMNewToken(chunk.text, undefined, undefined, undefined, undefined, { chunk });
      yield chunk;
      throw failure;
    }
  }
  const lines: string[] = [];

  await assert.rejects(
    runSupportCli(createSupportAgent(new InterruptedModel()), "测试断流", (text) => lines.push(text.trimEnd()), true),
    (error: unknown) => error === failure,
  );

  assert.ok(lines.some((line) => line.startsWith("[文本片段]")));
  assert.match(lines.at(-1) ?? "", /^\[失败\]/);
  assert.doesNotMatch(lines.join("\n"), /\[最终回答\]|\[完成\]/);
});
