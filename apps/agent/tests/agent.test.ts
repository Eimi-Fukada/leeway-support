import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, fakeModel } from "langchain";
import { createSupportAgent } from "../src/agent.ts";

// fakeModel 只控制模型这一外部依赖；每个用例都执行真实 Agent 流程。
// 这里的消息是测试数据，不是客服的问答规则；本文件不导入真实模型配置。
test("用户消息与客服提示词传入模型，模型回答后流程正常结束", async () => {
  const question = "这是一条流程测试输入。";
  const model = fakeModel().respond((messages) => {
    // 在模型边界检查 Agent 实际传来的消息，而不只检查最终输出。
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.type, "system");
    assert.match(messages[0]?.text ?? "", /Leeway Support/);
    assert.equal(messages[1]?.type, "human");
    assert.equal(messages[1]?.text, question);
    return new AIMessage("模型测试返回值");
  });
  const agent = createSupportAgent(model);

  const result = await agent.invoke({
    messages: [{ role: "user", content: question }],
  });

  assert.equal(model.calls.length, 1); // 无工具调用时不应继续循环。
  assert.deepEqual(result.messages.map((message) => message.type), ["human", "ai"]);
  assert.equal(result.messages[0]?.text, question);
  assert.equal(result.messages[1]?.text, "模型测试返回值");
});

test("同一 Agent 可接收不同输入，未开启记忆时各次运行互不携带历史", async () => {
  // 用输入相关的响应检查消息传递，无需建立固定问答映射。
  const model = fakeModel()
    .respond((messages) => new AIMessage(`收到：${messages.at(-1)?.text}`))
    .respond((messages) => new AIMessage(`收到：${messages.at(-1)?.text}`));
  const agent = createSupportAgent(model);

  for (const question of ["第一条测试输入", "另一条测试输入"]) {
    const result = await agent.invoke({
      messages: [{ role: "user", content: question }],
    });
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages.at(-1)?.text, `收到：${question}`);
  }

  assert.equal(model.calls.length, 2);
  for (const call of model.calls) {
    assert.equal(call.messages.filter((message) => message.type === "human").length, 1);
    assert.equal(call.messages.filter((message) => message.type === "ai").length, 0);
  }
});

test("模型失败时流程拒绝完成，不将异常转换成成功回答", async () => {
  const failure = new Error("模拟模型调用失败");
  // respond(Error) 让模型替身抛错，用于验证错误传播，不请求任何模型服务。
  const model = fakeModel().respond(failure);
  const agent = createSupportAgent(model);

  await assert.rejects(
    agent.invoke({ messages: [{ role: "user", content: "触发失败场景" }] }),
    (error: unknown) => error === failure,
  );
  assert.equal(model.calls.length, 1);
});
