import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, HumanMessage, countTokensApproximately, fakeModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { createSupportAgent } from "../src/agent/agent.ts";
import { runSupportAgent } from "../src/agent/run.ts";
import { createSummaryMiddleware } from "../src/agent/middleware/summarization.ts";

const first = "用户明确使用 Windows 桌面版。" + "背景说明。".repeat(80);
const second = "用户已尝试重启。" + "问题描述。".repeat(80);
const current = "现在仍然失败，请继续排查。" + "补充现象。".repeat(30);
const firstAnswer = "请尝试重启";
const secondAnswer = "请补充现象";
const threshold = countTokensApproximately([
  new HumanMessage(first), new AIMessage(firstAnswer), new HumanMessage(second), new AIMessage(secondAnswer),
]) + 10;

test("短对话不调用摘要，触发后主模型收到摘要和近期消息，摘要不展示给用户", async () => {
  const summaryText = "内部摘要：用户使用Windows桌面版，已尝试重启，问题尚未解决。";
  const summaryModel = fakeModel().respond((messages) => {
    assert.match(messages.at(-1)?.text ?? "", /用户明确使用 Windows/);
    return new AIMessage(summaryText);
  });
  const model = fakeModel().respond(new AIMessage(firstAnswer)).respond(new AIMessage(secondAnswer))
    .respond((messages) => {
      assert.equal(messages[0]?.type, "system");
      assert.match(messages[0]?.text ?? "", /Leeway Support/);
      assert.ok(messages.some((message) => message.additional_kwargs.lc_source === "summarization"));
      assert.equal(messages.at(-1)?.text, current);
      assert.ok(!messages.some((message) => message.text === first));
      return new AIMessage("请提供错误信息");
    });
  const saver = new MemorySaver();
  const agent = createSupportAgent(model, saver, { model: summaryModel, triggerTokens: threshold, keepMessages: 2 });
  await runSupportAgent(agent, first, undefined, "summary-a");
  await runSupportAgent(agent, second, undefined, "summary-a");
  assert.equal(summaryModel.calls.length, 0);
  const previous = await saver.getTuple({ configurable: { thread_id: "summary-a" } });
  assert.ok(previous);
  const events: string[] = [];
  const result = await runSupportAgent(agent, current, (event) => {
    if (event.type === "text") events.push(event.text);
  }, "summary-a");
  assert.equal(result.answer, "请提供错误信息");
  assert.equal(events.join(""), "请提供错误信息");
  assert.equal(summaryModel.calls.length, 1);
  assert.equal(model.calls.length, 3);
  const latest = await agent.graph.getState({ configurable: { thread_id: "summary-a" } });
  assert.ok(latest.values.messages.some((message: { additional_kwargs: Record<string, unknown> }) => message.additional_kwargs.lc_source === "summarization"));
  // 摘要修改最新状态，不删除旧 checkpoint；旧原文仍能按 checkpoint_id 读取。
  const original = await saver.getTuple(previous.config);
  assert.ok(JSON.stringify(original?.checkpoint.channel_values.messages).includes(first));
});

for (const response of [new Error("模拟摘要失败的内部信息"), new AIMessage("   "), new AIMessage("重复内容".repeat(1000))]) {
  test(`无效摘要不替换历史、不继续主模型：${response instanceof Error ? "调用错误" : response.text.trim() ? "未压缩" : "空结果"}`, async () => {
    const summaryModel = fakeModel().respond(response);
    const model = fakeModel().respond(new AIMessage(firstAnswer)).respond(new AIMessage(secondAnswer));
    const agent = createSupportAgent(model, new MemorySaver(), { model: summaryModel, triggerTokens: threshold, keepMessages: 2 });
    await runSupportAgent(agent, first, undefined, "failed-summary");
    await runSupportAgent(agent, second, undefined, "failed-summary");
    const events: string[] = [];
    await assert.rejects(runSupportAgent(agent, current, (event) => {
      if (event.type === "text") events.push(event.text);
    }, "failed-summary"), /摘要失败/);
    assert.equal(model.calls.length, 2);
    assert.equal(summaryModel.calls.length, 1);
    assert.equal(events.join(""), "");
    const state = await agent.graph.getState({ configurable: { thread_id: "failed-summary" } });
    const text = JSON.stringify(state.values.messages);
    assert.ok(text.includes(first) && text.includes(second) && text.includes(current));
    assert.ok(!text.includes("Error generating summary:") && !text.includes("模拟摘要失败的内部信息"));
  });
}

test("没有可压缩的旧消息时不额外生成摘要；超大历史在模型调用前失败", async () => {
  const summaryModel = fakeModel();
  const model = fakeModel().respond(new AIMessage("回答"));
  const agent = createSupportAgent(model, undefined, { model: summaryModel, triggerTokens: 1, keepMessages: 2 });
  assert.equal((await runSupportAgent(agent, "短问题")).answer, "回答");
  assert.equal(summaryModel.calls.length, 0);
  await assert.rejects(runSupportAgent(agent, "x".repeat(64_004)), /历史超过/);
  assert.equal(model.calls.length, 1);
  assert.equal(summaryModel.calls.length, 0);
});

test("摘要配置非法时提前报错，配置不依赖真实模型凭据", () => {
  const model = fakeModel();
  for (const options of [{ triggerTokens: 0 }, { triggerTokens: NaN }, { triggerTokens: 16000 }, { keepMessages: 1 }, { keepMessages: 2.5 }]) {
    assert.throws(() => createSummaryMiddleware(model, options), /摘要配置错误/);
  }
});
