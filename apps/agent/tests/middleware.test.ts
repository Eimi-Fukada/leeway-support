import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, AIMessageChunk, HumanMessage, fakeModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { FakeBuiltModel } from "@langchain/core/testing";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { createSupportAgent } from "../src/agent/agent.ts";
import { runSupportAgent } from "../src/agent/run.ts";
import { redactPii } from "../src/agent/middleware/pii.ts";
import { MemoryService } from "../src/memory/service.ts";
import { TestMemoryRepository } from "./fixtures/memory-repository.ts";
import { TestInformationBackend } from "./fixtures/information-backend.ts";
import { localSupportContext } from "../src/support-context.ts";

const sensitive = "邮箱 grace@example.com 手机 +86 13800138000 卡号 4111 1111 1111 1111";
const redacted = "邮箱 [REDACTED_EMAIL] 手机 [REDACTED_CN_PHONE] 卡号 [REDACTED_CREDIT_CARD]";

test("PII 规则脱敏且幂等，不误删普通编号；银行卡通过校验才匹配", () => {
  assert.equal(redactPii(sensitive), redacted);
  assert.equal(redactPii(redacted), redacted);
  assert.equal(redactPii("任务 T13800138000，错误码 E500，卡 4111 1111 1111 1112"), "任务 T13800138000，错误码 E500，卡 4111 1111 1111 1112");
});

test("输入在 Graph 前脱敏：模型、所有新 checkpoint 与根 callback 都没有输入原文", async () => {
  const observed: string[] = [];
  const model = fakeModel().respond((messages) => {
    assert.equal(messages.at(-1)?.text, redacted);
    return new AIMessage("请描述问题");
  });
  const saver = new MemorySaver();
  const agent = createSupportAgent(model, saver).withConfig({ callbacks: [{
    name: "capture-input", handleChainStart: (_chain, inputs) => { observed.push(JSON.stringify(inputs)); },
  }] });
  await runSupportAgent(agent, sensitive, undefined, "pii");
  for await (const tuple of saver.list({ configurable: { thread_id: "pii" } })) {
    assert.doesNotMatch(JSON.stringify(tuple.checkpoint), /grace@example\.com|13800138000|4111 1111/);
  }
  assert.ok(observed.length > 0);
  assert.doesNotMatch(observed.join(""), /grace@example\.com|13800138000|4111 1111/);
});

test("恢复的历史在摘要前清理，摘要模型和主模型都不收到旧 PII", async () => {
  const history = sensitive + "背景材料".repeat(100);
  const summaryModel = fakeModel().respond((messages) => {
    assert.doesNotMatch(JSON.stringify(messages), /grace@example\.com|13800138000|4111 1111/);
    assert.match(JSON.stringify(messages), /REDACTED_EMAIL/);
    return new AIMessage("用户此前提供了联系方式，现需排查故障。");
  });
  const model = fakeModel().respond((messages) => {
    assert.doesNotMatch(JSON.stringify(messages), /grace@example\.com|13800138000|4111 1111/);
    return new AIMessage("请补充错误码");
  });
  const agent = createSupportAgent(model, undefined, { model: summaryModel, triggerTokens: 80, keepMessages: 2 });
  await agent.invoke({ messages: [new HumanMessage(history), new AIMessage("收到"), new HumanMessage("当前问题"), new AIMessage("请继续"), new HumanMessage("需要帮助")] });
  assert.equal(summaryModel.calls.length, 1);
  assert.equal(model.calls.length, 1);
});

test("暂时失败在未输出时重试一次，每次仍使用脱敏输入", async () => {
  const model = fakeModel().respond(Object.assign(new Error("临时失败"), { status: 503 }))
    .respond((messages) => { assert.equal(messages.at(-1)?.text, redacted); return new AIMessage("恢复成功"); });
  assert.equal((await runSupportAgent(createSupportAgent(model), sensitive)).answer, "恢复成功");
  assert.equal(model.calls.length, 2);
});

test("重试耗尽仍传播异常根因，最多两次，不生成错误回答", async () => {
  const failure = Object.assign(new Error("敏感错误"), { status: 429 });
  const model = fakeModel().respond(failure).respond(failure).respond(new AIMessage("不应执行"));
  const output: string[] = [];
  await assert.rejects(runSupportAgent(createSupportAgent(model), "问题", (event) => {
    if (event.type === "text") output.push(event.text);
  }), (error: unknown) => (error === failure || (error instanceof Error && error.cause === failure)));
  assert.equal(model.calls.length, 2);
  assert.equal(output.join(""), "");
});

for (const info of [{ status: 401 }, { status: 400 }, { status: 429, code: "insufficient_quota" }, { status: 429, retryAfterMs: 60_000 }, { status: 429, headers: { "retry-after": "60" } }, { name: "AbortError" }, { name: "TimeoutError" }, {}]) {
  test(`不重试永久/取消/超时/过长等待/未知错误 ${JSON.stringify(info)}`, async () => {
    const failure = Object.assign(new Error("失败"), info);
    const model = fakeModel().respond(failure).respond(new AIMessage("不应执行"));
    await assert.rejects(runSupportAgent(createSupportAgent(model), "问题"), (error: unknown) => (error === failure || (error instanceof Error && error.cause === failure)));
    assert.equal(model.calls.length, 1);
  });
}

test("已产生片段后即使抛 503 也不重试或拼接另一回答", async () => {
  const failure = Object.assign(new Error("断流"), { status: 503 });
  class Interrupted extends FakeBuiltModel {
    attempts = 0;
    override bindTools() { return this; }
    override async *_streamResponseChunks(_messages: BaseMessage[], _options: this["ParsedCallOptions"], manager?: CallbackManagerForLLMRun) {
      this.attempts++;
      const chunk = new ChatGenerationChunk({ text: "半截", message: new AIMessageChunk("半截") });
      await manager?.handleLLMNewToken(chunk.text, undefined, undefined, undefined, undefined, { chunk });
      yield chunk;
      throw failure;
    }
  }
  const model = new Interrupted();
  const output: string[] = [];
  await assert.rejects(runSupportAgent(createSupportAgent(model), "问题", (event) => {
    if (event.type === "text") output.push(event.text);
  }), (error: unknown) => (error === failure || (error instanceof Error && error.cause === failure)));
  assert.equal(model.attempts, 1);
  assert.equal(output.join(""), "半截");
});

test("摘要内部暂时错误不被主回答重试层重试", async () => {
  const summary = fakeModel().respond(Object.assign(new Error("摘要失败"), { status: 503 }));
  const model = fakeModel();
  const agent = createSupportAgent(model, undefined, { model: summary, triggerTokens: 30, keepMessages: 2 });
  await assert.rejects(agent.invoke({ messages: [
    new HumanMessage("背景".repeat(300)), new AIMessage("收到"), new HumanMessage("问题"), new AIMessage("继续"), new HumanMessage("追问"),
  ] }), /摘要失败/);
  assert.equal(summary.calls.length, 1);
  assert.equal(model.calls.length, 0);
});

test("并行运行的流进度互相隔离，一个会话输出不阻止另一会话重试", async () => {
  const first = fakeModel().respond(new AIMessage("第一个会话回答"));
  const second = fakeModel().respond(Object.assign(new Error("暂时不可用"), { status: 503 }))
    .respond(new AIMessage("另一个会话成功"));
  let other: Promise<{ answer: string }> | undefined;
  await runSupportAgent(createSupportAgent(first), "第一问", (event) => {
    if (event.type === "text" && !other) other = runSupportAgent(createSupportAgent(second), "另一问");
  });
  assert.ok(other);
  assert.equal((await other).answer, "另一个会话成功");
  assert.equal(second.calls.length, 2);
});

test("生产装配记忆和补资料后，主模型 503 仍重试一次且记忆只读取一次", async () => {
  const repository = new TestMemoryRepository(); let reads = 0;
  const originalList = repository.list.bind(repository);
  repository.list = async (scope) => { reads++; return originalList(scope); };
  const model = fakeModel().respond(Object.assign(new Error("temporary"), { status: 503 })).respond(new AIMessage("恢复成功"));
  const information = new TestInformationBackend();
  const agent = createSupportAgent(model, new MemorySaver(), {}, {}, new MemoryService(repository), information);
  const result = await runSupportAgent(agent, "问题", undefined, "full-assembly", localSupportContext("retry-audit"), { service: information });
  assert.equal(result.answer, "恢复成功"); assert.equal(model.calls.length, 2); assert.equal(reads, 1);
});

test("生产装配的记忆存储故障不被主模型重试器重试，也不触发模型", async () => {
  const repository = new TestMemoryRepository(); let reads = 0;
  repository.list = async () => { reads++; throw Object.assign(new Error("storage unavailable"), { status: 503 }); };
  const information = new TestInformationBackend(); const model = fakeModel();
  const agent = createSupportAgent(model, new MemorySaver(), {}, {}, new MemoryService(repository), information);
  await assert.rejects(runSupportAgent(agent, "问题", undefined, "failed-storage", localSupportContext("retry-audit"), { service: information }), /长期记忆读取失败/);
  assert.equal(model.calls.length, 0); assert.equal(reads, 1);
});
