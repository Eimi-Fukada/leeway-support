import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, HumanMessage, createAgent, fakeModel, tool } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { createSupportAgent } from "../src/agent/agent.ts";
import { runSupportAgent } from "../src/agent/run.ts";
import { createModelCallLimitMiddleware } from "../src/agent/middleware/model-call-limit.ts";
import { createToolCallLimitMiddleware } from "../src/agent/middleware/tool-call-limit.ts";
import { runSupportCli } from "../src/cli/chat.ts";

function toolsFixture() {
  const executed: string[] = [];
  const tools = ["read_one", "read_two"].map((name) => tool(async () => {
    executed.push(name);
    return "fixture-result";
  }, { name, description: "仅用于预算测试的无副作用工具", schema: { type: "object", properties: {} } }));
  return { tools, executed };
}

function calls(...names: string[]) {
  return new AIMessage({ content: "", tool_calls: names.map((name, index) => ({ name, args: {}, id: `${name}-${index}`, type: "tool_call" as const })) });
}

test("主路径每轮重置，thread 计数保留；到达上限的下一轮不调用模型，新 thread 独立", async () => {
  const model = fakeModel().respond(new AIMessage("一")).respond(new AIMessage("二")).respond(new AIMessage("新会话"));
  const agent = createSupportAgent(model, new MemorySaver(), {}, { model: { runLimit: 1, threadLimit: 2 } });
  await runSupportAgent(agent, "第一问", undefined, "budget-a");
  await runSupportAgent(agent, "第二问", undefined, "budget-a");
  const saved = await agent.graph.getState({ configurable: { thread_id: "budget-a" } });
  assert.equal(saved.values.threadModelCallCount, 2);
  assert.equal(saved.values.runModelCallCount, 0);
  const output: string[] = [];
  await assert.rejects(runSupportAgent(agent, "超限问题", (event) => {
    if (event.type === "text") output.push(event.text);
  }, "budget-a"), /Model call limits exceeded/);
  assert.equal(model.calls.length, 2);
  assert.equal(output.join(""), "");
  await runSupportAgent(agent, "新会话问题", undefined, "budget-b");
  assert.equal(model.calls.length, 3);
});

test("无工具主 Agent 也装配工具限制器，普通回答不会消耗工具预算", async () => {
  const model = fakeModel().respond(new AIMessage("回答"));
  const agent = createSupportAgent(model, new MemorySaver());
  await runSupportAgent(agent, "问题", undefined, "no-tool");
  const state = await agent.graph.getState({ configurable: { thread_id: "no-tool" } });
  assert.deepEqual(state.values.threadToolCallCount, {});
  assert.deepEqual(state.values.runToolCallCount, {});
});

test("模型 run 上限阻止连续工具循环的下一次模型调用", async () => {
  const fixture = toolsFixture();
  const model = fakeModel().respond(calls("read_one")).respond(calls("read_two")).respond(new AIMessage("不应执行"));
  const agent = createAgent({ model, tools: fixture.tools, middleware: [
    createModelCallLimitMiddleware({ runLimit: 2, threadLimit: 10 }),
    createToolCallLimitMiddleware({ runLimit: 4, threadLimit: 10 }),
  ] });
  await assert.rejects(agent.invoke({ messages: [new HumanMessage("测试循环")] }), /Model call limits exceeded/);
  assert.equal(model.calls.length, 2);
  assert.deepEqual(fixture.executed, ["read_one", "read_two"]);
});

test("工具预算内允许一批并行调用，每个调用计一次，完成后 run 清零", async () => {
  const fixture = toolsFixture();
  const model = fakeModel().respond(calls("read_one", "read_two")).respond(new AIMessage("完成"));
  const agent = createAgent({ model, tools: fixture.tools, checkpointer: new MemorySaver(), middleware: [
    createModelCallLimitMiddleware(), createToolCallLimitMiddleware({ runLimit: 2, threadLimit: 4 }),
  ] });
  const result = await agent.invoke({ messages: [new HumanMessage("批次")] }, { configurable: { thread_id: "tools" } });
  assert.deepEqual(fixture.executed.sort(), ["read_one", "read_two"]);
  assert.equal(result.threadToolCallCount.__all__, 2);
  assert.deepEqual(result.runToolCallCount, {});
  assert.equal(model.calls.length, 2);
});

test("并行工具批次超限时整批不执行，不将额度内部分偷偷执行", async () => {
  const fixture = toolsFixture();
  const model = fakeModel().respond(calls("read_one", "read_two")).respond(new AIMessage("不应执行"));
  const agent = createAgent({ model, tools: fixture.tools, middleware: [
    createModelCallLimitMiddleware(), createToolCallLimitMiddleware({ runLimit: 1, threadLimit: 4 }),
  ] });
  await assert.rejects(agent.invoke({ messages: [new HumanMessage("批次")] }), /Tool call limit reached/);
  assert.equal(fixture.executed.length, 0);
  assert.equal(model.calls.length, 1);
});

test("工具 run 每轮重置，thread 跨轮保留，耗尽后的工具确实未执行", async () => {
  const fixture = toolsFixture();
  const model = fakeModel().respond(calls("read_one")).respond(new AIMessage("一"))
    .respond(calls("read_two")).respond(new AIMessage("二"))
    .respond(calls("read_one"));
  const agent = createAgent({ model, tools: fixture.tools, checkpointer: new MemorySaver(), middleware: [
    createModelCallLimitMiddleware(), createToolCallLimitMiddleware({ runLimit: 1, threadLimit: 2 }),
  ] });
  const config = { configurable: { thread_id: "thread-tools" } };
  await agent.invoke({ messages: [new HumanMessage("一")] }, config);
  await agent.invoke({ messages: [new HumanMessage("二")] }, config);
  await assert.rejects(agent.invoke({ messages: [new HumanMessage("三")] }, config), /Tool call limit reached/);
  assert.deepEqual(fixture.executed, ["read_one", "read_two"]);
  assert.equal(model.calls.length, 5);
});

test("重试成功只计一个主模型步骤，耗尽时仍传播失败，不把 attempts 当步骤", async () => {
  const model = fakeModel().respond(Object.assign(new Error("503"), { status: 503 })).respond(new AIMessage("成功"));
  const agent = createSupportAgent(model, new MemorySaver(), {}, { model: { runLimit: 1, threadLimit: 1 } });
  await runSupportAgent(agent, "重试", undefined, "retry-budget");
  const state = await agent.graph.getState({ configurable: { thread_id: "retry-budget" } });
  assert.equal(model.calls.length, 2);
  assert.equal(state.values.threadModelCallCount, 1);
  await assert.rejects(runSupportAgent(agent, "不应调用", undefined, "retry-budget"), /Model call limits exceeded/);
  assert.equal(model.calls.length, 2);
});

test("失败调用不增加官方成功步骤计数，失败请求保持未完成状态", async () => {
  const saver = new MemorySaver();
  const model = fakeModel().respond(new Error("不可重试失败"));
  const agent = createSupportAgent(model, saver);
  await assert.rejects(runSupportAgent(agent, "失败", undefined, "failed-budget"), /不可重试失败/);
  const state = await agent.graph.getState({ configurable: { thread_id: "failed-budget" } });
  assert.equal(state.values.threadModelCallCount, 0);
  assert.equal(state.values.runModelCallCount, 0);
  assert.ok(state.next.length > 0);
});

test("会话主模型预算耗尽时，在摘要前停止，不花额外摘要调用", async () => {
  const summary = fakeModel();
  const model = fakeModel().respond(new AIMessage("收到"));
  const agent = createSupportAgent(model, new MemorySaver(), { model: summary, triggerTokens: 100, keepMessages: 2 },
    { model: { runLimit: 1, threadLimit: 1 } });
  await runSupportAgent(agent, "第一问", undefined, "summary-budget");
  await assert.rejects(runSupportAgent(agent, "背景".repeat(500), undefined, "summary-budget"), /Model call limits exceeded/);
  assert.equal(summary.calls.length, 0);
  assert.equal(model.calls.length, 1);
});

test("摘要内部调用不计主模型计数，成功摘要后本轮主模型计一次", async () => {
  const summary = fakeModel().respond(new AIMessage("用户需要排查问题"));
  const model = fakeModel().respond(new AIMessage("回答"));
  const agent = createSupportAgent(model, undefined, { model: summary, triggerTokens: 100, keepMessages: 2 },
    { model: { runLimit: 1, threadLimit: 1 } });
  const result = await agent.invoke({ messages: [new HumanMessage("背景".repeat(500)), new AIMessage("收到"),
    new HumanMessage("补充"), new AIMessage("继续"), new HumanMessage("问题")] });
  assert.equal(summary.calls.length, 1);
  assert.equal(model.calls.length, 1);
  assert.equal(result.threadModelCallCount, 1);
});

test("预算配置拒绝零、负数、小数、非有限数和 thread 小于 run", () => {
  for (const factory of [createModelCallLimitMiddleware, createToolCallLimitMiddleware]) {
    for (const options of [{ runLimit: 0 }, { threadLimit: -1 }, { runLimit: 1.5 }, { runLimit: NaN },
      { threadLimit: Infinity }, { runLimit: 5, threadLimit: 2 }]) {
      assert.throws(() => factory(options), /调用预算配置错误/);
    }
  }
});

test("CLI 超限时只报告失败，不把上轮回答或限制提示当成本轮完成", async () => {
  const model = fakeModel().respond(new AIMessage("上轮回答"));
  const agent = createSupportAgent(model, new MemorySaver(), {}, { model: { runLimit: 1, threadLimit: 1 } });
  await runSupportAgent(agent, "第一问", undefined, "cli-budget");
  const output: string[] = [];
  await assert.rejects(runSupportCli(agent, "第二问", (text) => output.push(text), true, "cli-budget"), /Model call limits exceeded/);
  assert.match(output.join(""), /\[失败\]/);
  assert.doesNotMatch(output.join(""), /\[完成\]|\[最终回答\]|上轮回答/);
  assert.equal(model.calls.length, 1);
});

test("旧 checkpoint 没有预算字段时使用默认零值，不追溯推算历史调用", async () => {
  const saver = new MemorySaver();
  const oldModel = fakeModel().respond(new AIMessage("旧回答"));
  await createAgent({ model: oldModel, checkpointer: saver }).invoke({ messages: [new HumanMessage("旧问题")] },
    { configurable: { thread_id: "legacy" } });
  const model = fakeModel().respond((messages) => {
    assert.deepEqual(messages.slice(1).map((message) => message.text), ["旧问题", "旧回答", "新问题"]);
    return new AIMessage("新回答");
  });
  const agent = createSupportAgent(model, saver, {}, { model: { runLimit: 1, threadLimit: 1 } });
  await runSupportAgent(agent, "新问题", undefined, "legacy");
  const state = await agent.graph.getState({ configurable: { thread_id: "legacy" } });
  assert.equal(state.values.threadModelCallCount, 1);
  assert.equal(model.calls.length, 1);
});
