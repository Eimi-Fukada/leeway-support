import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AIMessage, fakeModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { createSupportAgent } from "../src/agent/agent.ts";
import { runSupportAgent } from "../src/agent/run.ts";
import { localSupportContext, checkpointThreadId, memoryScope } from "../src/support-context.ts";
import { conversationSnapshot, requestHash } from "../src/conversations/execution.ts";
import { TestInformationBackend } from "./fixtures/information-backend.ts";
import { TestConversationBackend } from "./fixtures/conversation-backend.ts";
import { SupportUiAgent } from "../src/ui/adapter.ts";
import { TestMemoryRepository } from "./fixtures/memory-repository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { canSendConversationMessage } from "../src/conversations/contracts.ts";

const context = localSupportContext("journal-test");
const scope = memoryScope(context);
function fixture(model: ReturnType<typeof fakeModel>) {
  const information = new TestInformationBackend();
  const conversation = new TestConversationBackend();
  const agent = createSupportAgent(model, new MemorySaver(), {}, {}, undefined, information);
  return { information, conversation, agent };
}

test("普通请求同 ID 同内容重放，不重复模型、消息或记忆；变更载荷拒绝", async () => {
  const model = fakeModel().respond(new AIMessage("完整回答"));
  const { information, conversation, agent } = fixture(model);
  const interaction = { service: information, conversation, requestId: "request-1" };
  const first = await runSupportAgent(agent, "问题", undefined, "thread", context, interaction);
  const again = await runSupportAgent(agent, "问题", undefined, "thread", context, interaction);
  assert.deepEqual(again, first);
  await assert.rejects(runSupportAgent(agent, "修改后的问题", undefined, "thread", context, interaction), /不同内容/);
  assert.equal(model.calls.length, 1);
  const snapshot = await conversationSnapshot(agent, information, conversation, scope, checkpointThreadId("thread", context), true);
  assert.deepEqual(snapshot.messages.map((message) => [message.role, message.content]), [["user", "问题"], ["assistant", "完整回答"]]);
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.requests.length, 1);
});

test("档案不随摘要删除，读取历史不调用模型/工具，不暴露内部消息", async () => {
  const model = fakeModel().respond(new AIMessage("第一轮回答"))
    .respond(new AIMessage("摘要：仅记录已知故障，未解决"))
    .respond(new AIMessage("第二轮回答"));
  const information = new TestInformationBackend(); const conversation = new TestConversationBackend();
  const agent = createSupportAgent(model, new MemorySaver(), { triggerTokens: 100, keepMessages: 2 }, {}, undefined, information);
  const longInput = "本轮现场材料".repeat(160);
  await runSupportAgent(agent, longInput, undefined, "summary", context, { service: information, conversation, requestId: "one" });
  await runSupportAgent(agent, "补充问题".repeat(160), undefined, "summary", context, { service: information, conversation, requestId: "two" });
  const snapshot = await conversationSnapshot(agent, information, conversation, scope, checkpointThreadId("summary", context), true);
  assert.equal(snapshot.messages.length, 4);
  assert.equal(snapshot.messages[0]!.content, longInput);
  assert.doesNotMatch(JSON.stringify(snapshot), /摘要：|systemPrompt|supportCompletionReceipt/);
  assert.equal(model.calls.length, 3);
  assert.equal(information.created, 0);
});

test("完成回执落 checkpoint 但档案未落库，核对后恢复结果，零重跑", async () => {
  const model = fakeModel().respond(new AIMessage("完成答案"));
  const { information, conversation, agent } = fixture(model);
  const normalFinish = conversation.finish.bind(conversation);
  conversation.finish = async () => { throw new Error("journal connection lost"); };
  const interaction = { service: information, conversation, requestId: "receipt" };
  await assert.rejects(runSupportAgent(agent, "问题", undefined, "receipt-thread", context, interaction), /journal connection lost/);
  conversation.finish = normalFinish;
  const snapshot = await conversationSnapshot(agent, information, conversation, scope, checkpointThreadId("receipt-thread", context), true);
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.messages.at(-1)!.content, "完成答案");
  const replay = await runSupportAgent(agent, "问题", undefined, "receipt-thread", context, interaction);
  assert.equal(replay.answer, "完成答案");
  assert.equal(model.calls.length, 1);
});

test("请求已接收但没有完成证据时标未知，拒绝重发及新消息；busy 仅返回 running", async () => {
  const model = fakeModel(); const { information, conversation, agent } = fixture(model);
  const thread = checkpointThreadId("unknown", context);
  await conversation.start(scope, thread, "lost", randomUUID(), requestHash("原问题"), "原问题");
  const busy = await conversationSnapshot(agent, information, conversation, scope, thread, false);
  assert.equal(busy.status, "running");
  const snapshot = await conversationSnapshot(agent, information, conversation, scope, thread, true);
  assert.equal(snapshot.status, "unknown");
  assert.match(snapshot.notice!, /未确认/);
  await assert.rejects(runSupportAgent(agent, "原问题", undefined, "unknown", context, { service: information, conversation, requestId: "lost" }), /结果未知/);
  await assert.rejects(runSupportAgent(agent, "新问题", undefined, "unknown", context, { service: information, conversation, requestId: "another" }), /未确认/);
  assert.equal(model.calls.length, 0);
});

test("模型异常只归档用户消息，失败不产生成功回答，原 ID 不会重试", async () => {
  const model = fakeModel().respond(new Error("private-provider-error"));
  const { information, conversation, agent } = fixture(model);
  const interaction = { service: information, conversation, requestId: "failed" };
  await assert.rejects(runSupportAgent(agent, "问题", undefined, "failure", context, interaction));
  const snapshot = await conversationSnapshot(agent, information, conversation, scope, checkpointThreadId("failure", context), true);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.messages.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-provider-error/);
  await assert.rejects(runSupportAgent(agent, "问题", undefined, "failure", context, interaction), /原请求执行失败/);
  assert.equal(model.calls.length, 1);
});

test("暂停/恢复都进入消息档案，重复提交不重复恢复，完成结果核对可修复表单账本", async () => {
  const spec = { title: "环境", description: "请选择环境", fields: [{ key: "os", type: "text", label: "操作系统", required: true }] };
  const model = fakeModel().respond(new AIMessage({ content: "", tool_calls: [{ name: "request_information", id: "ask", args: spec, type: "tool_call" }] }))
    .respond(new AIMessage("按 Windows 排查"));
  const { information, conversation, agent } = fixture(model);
  const first = await runSupportAgent(agent, "软件失败", undefined, "form", context, { service: information, conversation, requestId: "initial" });
  assert.equal(first.status, "waiting_for_input");
  const snapshot = await conversationSnapshot(agent, information, conversation, scope, checkpointThreadId("form", context), true);
  assert.equal(snapshot.information!.formId, first.information!.formId);
  const form = first.information!;
  const submission = { formId: form.formId, formVersion: 1 as const, interruptId: form.interruptId!, submissionId: "bd58cf67-1829-4dba-8877-01518afeb59a", answers: { os: "Windows" } };
  const result = await runSupportAgent(agent, "", undefined, "form", context, { service: information, conversation, submission });
  assert.deepEqual(await runSupportAgent(agent, "", undefined, "form", context, { service: information, conversation, submission }), result);
  const completed = await conversationSnapshot(agent, information, conversation, scope, checkpointThreadId("form", context), true);
  assert.deepEqual(completed.messages.map((message) => message.role), ["user", "user", "assistant"]);
  assert.match(completed.messages[1]!.content, /操作系统|Windows/);
  assert.doesNotMatch(JSON.stringify(completed), /tool_call_id|sourceText|supportCompletionReceipt/);
  assert.equal(information.created, 1);
  assert.equal(model.calls.length, 2);
  await assert.rejects(runSupportAgent(agent, "软件失败", undefined, "form", context, { service: information, conversation, requestId: "initial" }), /不再发布旧暂停点/);
  assert.equal(model.calls.length, 2);
});

test("相同 thread/请求 ID 跨用户隔离，旧会话不伪造完整历史", async () => {
  const model = fakeModel().respond(new AIMessage("旧回答")).respond(new AIMessage("用户A回答")).respond(new AIMessage("用户B回答"));
  const { information, conversation, agent } = fixture(model);
  const other = localSupportContext("other");
  await runSupportAgent(agent, "旧问题", undefined, "legacy", context, { service: information });
  await runSupportAgent(agent, "后续问题", undefined, "legacy", context, { service: information, conversation, requestId: "same" });
  const legacy = await conversationSnapshot(agent, information, conversation, scope, checkpointThreadId("legacy", context), true);
  assert.equal(legacy.historyComplete, false);
  assert.equal(legacy.messages.length, 2);
  assert.match(legacy.notice!, /旧会话/);
  const foreign = await conversationSnapshot(agent, information, conversation, memoryScope(other), checkpointThreadId("legacy", other), true);
  assert.equal(foreign.status, "empty"); assert.equal(foreign.messages.length, 0);
  await runSupportAgent(agent, "不同用户问题", undefined, "legacy", other, { service: information, conversation, requestId: "same" });
  assert.equal((await conversation.history(memoryScope(other), checkpointThreadId("legacy", other))).messages.length, 2);
});

test("AG-UI 用稳定用户消息 ID 与相同 assistant ID 重放，刷新档案不依赖客户端历史", async () => {
  const model = fakeModel().respond(new AIMessage("用户可见回答"));
  const { information, conversation, agent } = fixture(model);
  const ui = new SupportUiAgent(agent, information, context, conversation);
  ui.addMessage({ role: "user", id: "stable-message", content: "我的问题" });
  await ui.runAgent();
  const clone = new SupportUiAgent(agent, information, context, conversation);
  clone.threadId = ui.threadId;
  clone.addMessage({ role: "user", id: "stable-message", content: "我的问题" });
  await clone.runAgent();
  assert.equal(model.calls.length, 1);
  assert.equal(clone.messages.at(-1)!.id, "assistant-stable-message");
  assert.equal((await conversation.history(scope, checkpointThreadId(ui.threadId, context))).messages.length, 2);
});

test("重复普通消息不会二次写长期记忆，只有成功最终回答进入可见档案", async () => {
  const memory = new TestMemoryRepository(); const information = new TestInformationBackend(); const conversation = new TestConversationBackend();
  const fact = "部署环境长期不能联网";
  const model = fakeModel().respond(new AIMessage({ content: "", tool_calls: [{ name: "save_memory", args: { content: fact, evidenceQuote: fact }, id: "save", type: "tool_call" }] }))
    .respond(new AIMessage("已保存环境约束"));
  const agent = createSupportAgent(model, new MemorySaver(), {}, {}, new MemoryService(memory), information);
  const request = { service: information, conversation, requestId: "with-memory" };
  await runSupportAgent(agent, fact, undefined, "memory", context, request);
  await runSupportAgent(agent, fact, undefined, "memory", context, request);
  assert.equal(model.calls.length, 2); assert.equal(memory.writes.length, 1);
  const snapshot = await conversationSnapshot(agent, information, conversation, scope, checkpointThreadId("memory", context), true);
  assert.equal(snapshot.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), /saved|tool_call|evidenceQuote/);
});

test("旧完成回执不能证明一个新的未完成请求成功", async () => {
  const model = fakeModel().respond(new AIMessage("旧结果"));
  const { agent, conversation, information } = fixture(model);
  const thread = checkpointThreadId("stale-receipt", context);
  await runSupportAgent(agent, "先前请求", undefined, "stale-receipt", context, { service: information, conversation, requestId: "old" });
  await conversation.start(scope, thread, "new", randomUUID(), requestHash("新请求"), "新请求");
  const state = await conversationSnapshot(agent, information, conversation, scope, thread, true);
  assert.equal(state.status, "unknown");
  assert.equal(state.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(state.requests.at(-1)!.status, "unknown"); assert.equal(model.calls.length, 1);
});

test("归档入口缺少会话或请求 ID 时在接收前拒绝，不留下未知请求", async () => {
  const model = fakeModel(); const { information, conversation, agent } = fixture(model);
  await assert.rejects(runSupportAgent(agent, "问题", undefined, undefined, context, { service: information, conversation, requestId: "request" }), /会话标识/);
  await assert.rejects(runSupportAgent(agent, "问题", undefined, "thread", context, { service: information, conversation }), /请求 ID/);
  assert.equal(conversation.records.size, 0); assert.equal(model.calls.length, 0);
});

test("恢复请求接收后尚未 accept 就中断，旧暂停不能冒充该次恢复的等待回执", async () => {
  const model = fakeModel().respond(new AIMessage({ content: "", tool_calls: [{ name: "request_information", id: "ask", type: "tool_call", args: {
    title: "环境", description: "请补环境", fields: [{ key: "os", label: "系统", type: "text", required: true }],
  } }] }));
  const { information, conversation, agent } = fixture(model);
  const thread = checkpointThreadId("resume-crash", context);
  const first = await runSupportAgent(agent, "问题", undefined, "resume-crash", context, { service: information, conversation, requestId: "initial" });
  const form = first.information!;
  const submission = { formId: form.formId, formVersion: 1 as const, interruptId: form.interruptId!, submissionId: randomUUID(), answers: { os: "Windows" } };
  // 在实际恢复入口接受账本后注入崩溃，测试整个调用现场而非预置伪成功数据。
  const originalStart = conversation.start.bind(conversation);
  conversation.start = async (...args) => { await originalStart(...args); throw new Error("simulated crash before accept"); };
  await assert.rejects(runSupportAgent(agent, "", undefined, "resume-crash", context, { service: information, conversation, submission }), /simulated crash/);
  const snapshot = await conversationSnapshot(agent, information, conversation, scope, thread, true);
  assert.equal(snapshot.status, "unknown");
  assert.equal((await conversation.find(scope, thread, submission.submissionId))!.status, "unknown");
  await assert.rejects(runSupportAgent(agent, "", undefined, "resume-crash", context, { service: information, conversation, submission }), /结果未知/);
  assert.equal(information.submissions.size, 0);
  assert.equal(model.calls.length, 1);
});

test("等待表单读取故障不能被伪装成成功快照，恢复读取后仍显示原表单", async () => {
  const model = fakeModel().respond(new AIMessage({ content: "", tool_calls: [{ name: "request_information", id: "ask", type: "tool_call", args: {
    title: "环境", description: "请补环境", fields: [{ key: "os", label: "系统", type: "text", required: true }],
  } }] }));
  const { information, conversation, agent } = fixture(model);
  const first = await runSupportAgent(agent, "问题", undefined, "read-failure", context, { service: information, conversation, requestId: "initial" });
  const originalWait = information.wait.bind(information);
  information.wait = async () => { throw new Error("private-storage-error"); };
  await assert.rejects(conversationSnapshot(agent, information, conversation, scope, checkpointThreadId("read-failure", context), true), /等待表单读取失败/);
  information.wait = originalWait;
  const snapshot = await conversationSnapshot(agent, information, conversation, scope, checkpointThreadId("read-failure", context), true);
  assert.equal(snapshot.information!.formId, first.information!.formId);
  assert.equal(model.calls.length, 1);
});

test("即使缺少表单对象，waiting 状态也不允许普通消息输入", () => {
  assert.equal(canSendConversationMessage("waiting_for_input"), false);
  for (const status of ["running", "failed", "unknown"] as const) assert.equal(canSendConversationMessage(status), false);
  assert.equal(canSendConversationMessage("empty"), true);
  assert.equal(canSendConversationMessage("completed"), true);
});

test("普通消息的暂停发布丢失仍可核对为 waiting，不误伤正常暂停恢复", async () => {
  const model = fakeModel().respond(new AIMessage({ content: "", tool_calls: [{ name: "request_information", id: "ask", type: "tool_call", args: {
    title: "环境", description: "请补环境", fields: [{ key: "os", label: "系统", type: "text", required: true }],
  } }] }));
  const { information, conversation, agent } = fixture(model);
  const originalFinish = conversation.finish.bind(conversation);
  conversation.finish = async () => { throw new Error("pause publication lost"); };
  await assert.rejects(runSupportAgent(agent, "问题", undefined, "message-pause", context, { service: information, conversation, requestId: "initial" }));
  conversation.finish = originalFinish;
  const snapshot = await conversationSnapshot(agent, information, conversation, scope, checkpointThreadId("message-pause", context), true);
  assert.equal(snapshot.status, "waiting_for_input");
  assert.ok(snapshot.information?.interruptId);
  assert.equal((await conversation.find(scope, checkpointThreadId("message-pause", context), "initial"))!.kind, "message");
  assert.equal(model.calls.length, 1);
});
