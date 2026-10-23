import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { AIMessage, fakeModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { createSupportAgent } from "../src/agent/agent.ts";
import { chat } from "../src/cli/chat.ts";

test("多轮输入串行运行，新会话隔离，命令及空行不调用模型，exit 后不再提交", async () => {
  const model = fakeModel()
    .respond(new AIMessage("回答一"))
    .respond((messages) => {
      assert.deepEqual(messages.slice(1).map((m) => m.text), ["第一问", "回答一", "追问"]);
      return new AIMessage("回答二");
    })
    .respond((messages) => {
      assert.deepEqual(messages.slice(1).map((m) => m.text), ["新问题"]);
      return new AIMessage("回答三");
    });
  const output: string[] = [];
  await chat(createSupportAgent(model, new MemorySaver()),
    Readable.from(["  ", "第一问", "追问", "/unknown", "/new", "新问题", "/exit", "不应处理"]),
    (text) => output.push(text));
  assert.equal(model.calls.length, 3);
  assert.match(output.join(""), /未知命令/);
  assert.match(output.join(""), /\[新会话\]/);
  assert.match(output.join(""), /\[会话结束\]/);
});

test("失败后退出输入循环，后续行不再提交；debug 仍走相同会话路径", async () => {
  const failure = new Error("敏感供应商错误");
  const model = fakeModel().respond(failure);
  const output: string[] = [];
  await assert.rejects(chat(createSupportAgent(model, new MemorySaver()),
    Readable.from(["失败请求", "不应处理"]), (text) => output.push(text), true),
    (error: unknown) => error === failure);
  assert.equal(model.calls.length, 1);
  assert.match(output.join(""), /\[开始\]/);
  assert.match(output.join(""), /\[失败\]/);
  assert.doesNotMatch(output.join(""), /敏感供应商错误|\[完成\]|\[会话结束\]/);
});

test("EOF 没有输入时正常结束，不发送固定问题", async () => {
  const model = fakeModel();
  const output: string[] = [];
  await chat(createSupportAgent(model, new MemorySaver()), Readable.from([]), (text) => output.push(text));
  assert.equal(model.calls.length, 0);
  assert.match(output.join(""), /\[会话结束\]/);
});

test("显式恢复已完成会话后只提交新增问题", async () => {
  const saver = new MemorySaver();
  const model = fakeModel().respond(new AIMessage("先前回答")).respond((messages) => {
    assert.deepEqual(messages.slice(1).map((m) => m.text), ["先前问题", "先前回答", "继续问"]);
    return new AIMessage("继续回答");
  });
  const agent = createSupportAgent(model, saver);
  await agent.invoke({ messages: [{ role: "user", content: "先前问题" }] }, { configurable: { thread_id: "saved" } });
  const output: string[] = [];
  await chat(agent, Readable.from(["继续问", "/exit"]), (text) => output.push(text), false, "saved");
  assert.match(output.join(""), /已恢复会话/);
  assert.equal(model.calls.length, 2);
});

test("不存在或失败未完成的会话不自动恢复、不请求下一轮模型", async () => {
  const model = fakeModel().respond(new Error("模拟失败"));
  const agent = createSupportAgent(model, new MemorySaver());
  await assert.rejects(chat(agent, Readable.from(["问题"]), () => {}, false, "missing"), /未找到/);
  assert.equal(model.calls.length, 0);
  await assert.rejects(agent.invoke({ messages: [{ role: "user", content: "失败输入" }] }, {
    configurable: { thread_id: "failed" },
  }));
  await assert.rejects(chat(agent, Readable.from(["重试"]), () => {}, false, "failed"), /未完成步骤/);
  assert.equal(model.calls.length, 1);
});

test("恢复校验完成前不创建输入监听，失败时完全不消费输入", async () => {
  const agent = createSupportAgent(fakeModel(), new MemorySaver());
  let opened = false;
  await assert.rejects(chat(agent, () => {
    opened = true;
    return Readable.from(["不能丢失的输入"]);
  }, () => {}, false, "missing"), /未找到/);
  assert.equal(opened, false);
});
