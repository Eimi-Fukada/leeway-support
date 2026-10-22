import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { AIMessage, fakeModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { createSupportAgent } from "../src/agent.ts";
import { chat } from "../src/chat.ts";

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
