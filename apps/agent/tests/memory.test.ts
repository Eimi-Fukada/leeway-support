import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, fakeModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { createSupportAgent } from "../src/agent.ts";
import { runSupportAgent } from "../src/run.ts";

test("同一 thread 只提交新增消息，后续模型收到完整历史且其他 thread 隔离", async () => {
  const model = fakeModel()
    .respond(new AIMessage("已了解"))
    .respond((messages) => {
      assert.deepEqual(messages.slice(1).map((m) => [m.type, m.text]), [
        ["human", "我正在用桌面版"], ["ai", "已了解"], ["human", "刚才说的是哪个版本？"],
      ]);
      return new AIMessage("桌面版");
    })
    .respond((messages) => {
      assert.equal(messages.length, 2);
      assert.equal(messages.at(-1)?.text, "另一个会话");
      return new AIMessage("新对话");
    });
  const agent = createSupportAgent(model, new MemorySaver());
  await runSupportAgent(agent, "我正在用桌面版", undefined, "a");
  const result = await runSupportAgent(agent, "刚才说的是哪个版本？", undefined, "a");
  assert.equal(result.answer, "桌面版");
  await runSupportAgent(agent, "另一个会话", undefined, "b");
  assert.equal(model.calls.length, 3);
});

test("复用 saver 可读取已完成状态，新 saver 即使 thread 同名也没有历史", async () => {
  const saver = new MemorySaver();
  const first = createSupportAgent(fakeModel().respond(new AIMessage("回答")), saver);
  await runSupportAgent(first, "原始输入", undefined, "a");
  const sharedModel = fakeModel().respond((messages) => {
    assert.deepEqual(messages.slice(1).map((m) => m.text), ["原始输入", "回答", "继续"]);
    return new AIMessage("继续回答");
  });
  await runSupportAgent(createSupportAgent(sharedModel, saver), "继续", undefined, "a");

  const model = fakeModel().respond((messages) => {
    assert.equal(messages.length, 2);
    assert.equal(messages.at(-1)?.text, "新进程的输入");
    return new AIMessage("没有旧历史");
  });
  await runSupportAgent(createSupportAgent(model, new MemorySaver()), "新进程的输入", undefined, "a");
});

test("失败轮可留下已提交的用户输入，但不能写入伪成功回答或覆盖上一轮答案", async () => {
  const failure = new Error("模拟供应商失败");
  const model = fakeModel().respond(new AIMessage("上一轮回答")).respond(failure);
  const saver = new MemorySaver();
  const agent = createSupportAgent(model, saver);
  await runSupportAgent(agent, "第一轮", undefined, "a");
  await assert.rejects(runSupportAgent(agent, "失败轮", undefined, "a"), (error: unknown) => error === failure);
  const saved = await saver.getTuple({ configurable: { thread_id: "a" } });
  assert.ok(saved);
  const messages = saved.checkpoint.channel_values.messages as BaseMessage[];
  assert.deepEqual(messages.map((m) => [m.type, m.text]), [
    ["human", "第一轮"], ["ai", "上一轮回答"], ["human", "失败轮"],
  ]);
  assert.equal(model.calls.length, 2);
});

test("空输入和空 thread 在模型调用前拒绝，不产生 checkpoint", async () => {
  const model = fakeModel().respond(new AIMessage("不应调用"));
  const saver = new MemorySaver();
  const agent = createSupportAgent(model, saver);
  await assert.rejects(runSupportAgent(agent, "  ", undefined, "a"), /用户输入不能为空/);
  await assert.rejects(runSupportAgent(agent, "问题", undefined, "  "), /会话标识不能为空/);
  assert.equal(model.calls.length, 0);
  assert.equal(await saver.getTuple({ configurable: { thread_id: "a" } }), undefined);
});
