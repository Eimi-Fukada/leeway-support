import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, fakeModel } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { caseSchema, type StepEvidence } from "../evals/contracts.ts";
import { behaviorCases } from "../evals/dataset.ts";
import { runCase, formAnswers, type EvaluationServices } from "../evals/runner.ts";
import { checkRules } from "../evals/checks.ts";
import { parseEvalOptions } from "../evals/index.ts";
import { compareReports, markdownReport, sanitizeArtifact, type BehaviorReport } from "../evals/report.ts";
import { MemoryService } from "../src/memory/service.ts";
import { TestMemoryRepository } from "./fixtures/memory-repository.ts";
import { TestInformationBackend } from "./fixtures/information-backend.ts";

function services() {
  const repository = new TestMemoryRepository();
  const information = new TestInformationBackend();
  let cleaned = 0;
  const environment: EvaluationServices = { saver: new MemorySaver(), memory: new MemoryService(repository), information,
    cleanup: async (contexts) => {
      assert.ok(contexts.every((entry) => entry.subject.id.startsWith("eval-")));
      cleaned++; repository.rows.clear(); information.forms.clear();
    } };
  return { environment, repository, cleaned: () => cleaned };
}

test("首批 24 个用例均有检查和语义复核标准，CLI 列表/采样参数有边界", () => {
  assert.equal(behaviorCases.length, 24);
  assert.ok(behaviorCases.every((entry) => entry.review.length && entry.steps.every((step) => step.checks.length)));
  assert.deepEqual(parseEvalOptions(["--", "--case", "greeting", "--repeat", "3"]), { list: false, caseId: "greeting", repeat: 3 });
  for (const args of [["--repeat", "0"], ["--repeat", "6"], ["--case", "missing"], ["--out"], ["--list", "--list"], ["--unknown"]]) {
    assert.throws(() => parseEvalOptions(args), /评估/);
  }
});

test("运行真实 Agent，预期/复核标准不泄露给模型，记录 usage 并清理隔离数据", async () => {
  const fixture = services();
  const definition = caseSchema.parse({ id: "runner-smoke", category: "test", description: "测试", review: ["REVIEW_ONLY_DO_NOT_SEND"], steps: [
    { kind: "message", thread: "a", text: "你好", checks: [{ kind: "status", allowed: ["completed"] }, { kind: "model_attempts", min: 1, max: 1 }] },
  ] });
  const model = fakeModel().respond((messages) => {
    assert.doesNotMatch(messages.map((entry) => entry.text).join(""), /REVIEW_ONLY_DO_NOT_SEND|runner-smoke/);
    return new AIMessage({ content: "你好", usage_metadata: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } });
  });
  const result = await runCase(definition, 1, model, fixture.environment);
  assert.equal(result.automatic, "pass");
  assert.equal(result.semantic, "needs_review");
  assert.equal(result.steps[0]!.attempts.length, 1);
  assert.equal(result.steps[0]!.attempts[0]!.usage?.totalTokens, 16);
  assert.equal(result.steps[0]!.streamedText, "你好");
  assert.equal(fixture.cleaned(), 1);
});

test("模型的记忆工具提议和真实成功回执分别记录，跨 thread 状态可核对", async () => {
  const fixture = services();
  const fact = "公司不能访问外网";
  const definition = caseSchema.parse({ id: "runner-memory", category: "test", description: "测试", review: ["记忆语义需复核"], steps: [
    { kind: "message", thread: "a", text: fact, checks: [{ kind: "tool_calls", name: "save_memory", min: 1 }, { kind: "tool_successes", name: "save_memory", min: 1 }, { kind: "memory_count", min: 1, max: 1 }] },
    { kind: "message", thread: "b", text: "新会话", checks: [{ kind: "input_includes", text: fact }] },
  ] });
  const model = fakeModel().respond(new AIMessage({ content: "", tool_calls: [{ name: "save_memory", args: { content: fact, evidenceQuote: fact }, id: "call", type: "tool_call" }] }))
    .respond(new AIMessage("已保存")).respond(new AIMessage("考虑离线部署"));
  const result = await runCase(definition, 1, model, fixture.environment);
  assert.equal(result.automatic, "pass");
  assert.equal(result.steps[0]!.proposedTools[0]!.name, "save_memory");
  assert.equal(result.steps[0]!.executedTools[0]!.name, "save_memory");
  assert.equal(result.steps[0]!.memoryBefore.length, 0);
  assert.equal(result.steps[0]!.memoryAfter.length, 1);
  assert.equal(result.steps[1]!.memoryBefore.length, 1);
  assert.equal(fixture.repository.rows.size, 0);
});

test("服务/模型异常不按零工具或空记忆判为通过，缺失 usage 不补零", async () => {
  const fixture = services();
  const result = await runCase(behaviorCases.find((entry) => entry.id === "greeting")!, 1, fakeModel().respond(new Error("private-provider-error")), fixture.environment);
  assert.equal(result.execution, "error");
  assert.equal(result.automatic, "indeterminate");
  assert.ok(result.steps[0]!.checks.every((entry) => entry.verdict === "indeterminate"));
  assert.equal(result.steps[0]!.attempts[0]!.usage, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-error/);
  assert.equal(fixture.cleaned(), 1);
});

test("没有产生表单时不伪造 interrupt 或补充答案，而是保留行为失败", async () => {
  const fixture = services();
  const definition = behaviorCases.find((entry) => entry.id === "form-submit")!;
  const result = await runCase(definition, 1, fakeModel().respond(new AIMessage("直接回答")), fixture.environment);
  assert.equal(result.execution, "blocked");
  assert.equal(result.automatic, "fail");
  assert.equal(result.steps[1]!.error?.kind, "scenario_unfulfilled");
  assert.equal(result.steps[1]!.attempts.length, 0);
});

test("表单场景真的暂停和恢复，observe 不请求模型，interrupt 不记成工具成功", async () => {
  const fixture = services();
  const spec = { title: "补资料", description: "请选择系统", fields: [{ key: "os", type: "text", label: "操作系统", required: true }] };
  const model = fakeModel().respond(new AIMessage({ content: "", tool_calls: [{ name: "request_information", id: "form", args: spec, type: "tool_call" }] }))
    .respond(new AIMessage("已取消"));
  const result = await runCase(behaviorCases.find((entry) => entry.id === "form-observe")!, 1, model, fixture.environment);
  assert.equal(result.automatic, "pass");
  assert.equal(result.steps[0]!.result?.status, "waiting_for_input");
  assert.equal(result.steps[1]!.attempts.length, 0);
  assert.equal(result.steps[2]!.executedTools[0]!.name, "request_information");
});

test("动态表单没有唯一可用答案时不猜测或选择第一项", () => {
  const step = behaviorCases.find((entry) => entry.id === "form-submit")!.steps[1]!;
  assert.equal(step.kind, "submit");
  if (step.kind !== "submit") throw new Error();
  assert.throws(() => formAnswers(step, { schemaVersion: 1, formId: "x", formVersion: 1, status: "pending", expiresAt: "", spec: {
    title: "测试", description: "测试", fields: [{ key: "x", type: "text", label: "没有提供的字段", required: true }],
  } }), /无法.*唯一回答/);
});

test("自动检查依据工具回执而非模型声称，报告脱敏不能改变原检查结论", () => {
  const evidence: StepEvidence = { index: 0, actor: "a", thread: "a", kind: "message", streamedText: "已保存",
    attempts: [], proposedTools: [{ name: "save_memory" }], executedTools: [{ name: "save_memory", result: { status: "rejected" } }],
    memoryBefore: [], memoryAfter: [], checks: [], result: { status: "completed", answer: "password=EVAL_SECRET", runId: "r", elapsedMs: 0 } };
  const checks = checkRules([{ kind: "tool_successes", name: "save_memory", min: 1 }, { kind: "answer_excludes", text: "EVAL_SECRET" }], evidence);
  assert.ok(checks.every((entry) => entry.verdict === "fail"));
  const safe = sanitizeArtifact({ evidence, checks, key: "real-key-for-test", database: "postgresql://u:secret@localhost/db" }, ["real-key-for-test"]);
  assert.doesNotMatch(JSON.stringify(safe), /real-key-for-test|u:secret/);
  // 用例中的合成检查字面值保留，实际回答中的凭据值已经处理。
  assert.doesNotMatch(JSON.stringify((safe as { evidence: unknown }).evidence), /EVAL_SECRET/);
  assert.match(JSON.stringify(safe), /"verdict":"fail"/);
});

test("基线比较不把执行错误或不同数据集称为退化；相同自动检查可比较", async () => {
  const fixture = services();
  const result = await runCase(behaviorCases[0]!, 1, fakeModel().respond(new AIMessage("你好")), fixture.environment);
  const report: BehaviorReport = { schemaVersion: 1, createdAt: "now", datasetVersion: "v1", datasetHash: "hash", environment: {},
    selection: { caseIds: [result.id], repeat: 1 }, results: [result] };
  assert.equal(compareReports(report, report)[0]!.automatic, "unchanged");
  assert.equal(compareReports(report, { ...report, results: [{ ...result, automatic: "fail" }] })[0]!.automatic, "improved");
  assert.equal(compareReports(report, { ...report, datasetHash: "different" })[0]!.automatic, "not_comparable");
  assert.equal(compareReports(report, { ...report, results: [{ ...result, execution: "error", automatic: "indeterminate" }] })[0]!.automatic, "not_comparable");
  const markdown = markdownReport(report);
  assert.match(markdown, /全部待人工复核/);
  assert.match(markdown, /usage 覆盖 0\/1/);
});

test("清理失败明确保留身份范围并使样本未判定，不能当作通过", async () => {
  const fixture = services();
  fixture.environment.cleanup = async () => { throw new Error("db unavailable"); };
  const result = await runCase(behaviorCases[0]!, 1, fakeModel().respond(new AIMessage("你好")), fixture.environment);
  assert.equal(result.automatic, "indeterminate");
  assert.ok(result.cleanupError);
  assert.ok(result.actorIds.every((entry) => entry.startsWith("eval-")));
});

test("摘要在第二轮提前触发也满足场景要求，不强制第三轮再次摘要", async () => {
  const fixture = services();
  const model = fakeModel().respond(new AIMessage("收到"))
    .respond(new AIMessage("本轮临时现场：Windows 11，已重启仍失败，无更多诊断线索。"))
    .respond(new AIMessage("收到"))
    .respond(new AIMessage("Windows 11，重启后仍未解决，错误码 ERR-EVAL。"));
  const result = await runCase(behaviorCases.find((entry) => entry.id === "summary-facts")!, 1, model, fixture.environment);
  assert.equal(result.steps[1]!.attempts.filter((entry) => entry.kind === "summary").length, 1);
  assert.equal(result.steps[2]!.attempts.filter((entry) => entry.kind === "summary").length, 0);
  assert.equal(result.automatic, "pass");
  assert.equal(result.semantic, "needs_review");
});
