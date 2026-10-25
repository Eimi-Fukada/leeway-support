import { createHash, randomUUID } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { createSupportAgent } from "../src/agent/agent.ts";
import { runSupportAgent } from "../src/agent/run.ts";
import type { InformationBackend } from "../src/interactions/service.ts";
import type { InformationForm } from "../src/interactions/contracts.ts";
import type { MemoryService } from "../src/memory/service.ts";
import { localSupportContext, type SupportContext } from "../src/support-context.ts";
import type { BehaviorCase, BehaviorStep, CaseResult, StepEvidence } from "./contracts.ts";
import { EvaluationRecorder } from "./recorder.ts";
import { checkRules } from "./checks.ts";

export interface EvaluationServices {
  saver: BaseCheckpointSaver; memory: MemoryService; information: InformationBackend;
  cleanup(contexts: SupportContext[], threads: Array<{ context: SupportContext; id: string }>): Promise<void>;
}
export class ScenarioUnfulfilled extends Error {}
export function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function formAnswers(step: Extract<BehaviorStep, { kind: "submit" }>, form: InformationForm) {
  const result: Record<string, string> = {};
  for (const field of form.spec.fields) {
    const matches = step.answers.filter((entry) => new RegExp(entry.labelPattern, "i").test(field.label));
    if (matches.length > 1 || (field.required && !matches.length)) throw new ScenarioUnfulfilled("生成表单无法由该场景的用户资料唯一回答，需要人工复核字段。");
    const answer = matches[0];
    if (!answer) continue;
    if (field.type === "select") {
      const options = field.options.filter((option) => new RegExp(answer.optionPattern ?? answer.text, "i").test(option.label));
      if (options.length !== 1) throw new ScenarioUnfulfilled("表单选项没有唯一对应的测试答案；没有自动编造答案或选择第一项。");
      result[field.key] = options[0]!.value;
    } else result[field.key] = answer.text;
  }
  return result;
}

export async function runCase(definition: BehaviorCase, repetition: number, model: BaseChatModel, services: EvaluationServices): Promise<CaseResult> {
  const prefix = `eval-${randomUUID()}`;
  const contexts = { a: localSupportContext(`${prefix}-a`), b: localSupportContext(`${prefix}-b`) };
  const threads = new Map<string, { context: SupportContext; id: string }>();
  const pending = new Map<string, InformationForm>();
  const result: CaseResult = { id: definition.id, category: definition.category, description: definition.description,
    caseHash: hash(definition), repetition, actorIds: Object.values(contexts).map((entry) => entry.subject.id),
    execution: "ok", automatic: "pass", semantic: "needs_review", review: definition.review, steps: [] };
  try {
    for (const seed of definition.seeds) {
      const saved = await services.memory.write(contexts[seed.actor], { change: { action: "save", content: seed.content },
        operationId: `seed-${randomUUID()}`, threadId: "evaluation-seed", messageId: randomUUID(), evidenceQuote: seed.content, sourceText: seed.content });
      if (saved.status !== "saved") throw new Error("评估初始记忆准备失败。");
    }
    // 实际产品 Agent。评估标准/期望工具不传给模型；只允许显式摘要测试策略覆盖。
    const agent = createSupportAgent(model, services.saver, definition.summary ?? {}, {}, services.memory, services.information);
    for (const [index, step] of definition.steps.entries()) {
      const key = `${step.actor}:${step.thread}`;
      if (!threads.has(key)) threads.set(key, { context: contexts[step.actor], id: `eval-${randomUUID()}` });
      const thread = threads.get(key)!;
      const evidence: StepEvidence = { index, kind: step.kind, actor: step.actor, thread: step.thread,
        ...(step.kind === "message" ? { input: step.text } : {}), streamedText: "", attempts: [], proposedTools: [], executedTools: [],
        memoryBefore: [], memoryAfter: [], checks: [] };
      result.steps.push(evidence);
      try {
        evidence.memoryBefore = structuredClone(await services.memory.list(thread.context));
        const recorder = new EvaluationRecorder(evidence);
        let submission;
        if (step.kind === "submit" || step.kind === "cancel") {
          const form = pending.get(key);
          if (!form?.interruptId || form.status !== "pending") throw new ScenarioUnfulfilled("前一步未形成可提交的等待表单，后续用户操作无法执行。");
          submission = { formId: form.formId, formVersion: form.formVersion, interruptId: form.interruptId,
            submissionId: randomUUID(), cancelled: step.kind === "cancel", answers: step.kind === "cancel" ? {} : formAnswers(step, form) };
        }
        evidence.result = await runSupportAgent(agent.withConfig({ callbacks: [recorder] }), step.kind === "message" ? step.text : "",
          (event) => { if (event.type === "text") evidence.streamedText += event.text; }, thread.id, thread.context,
          { service: services.information, submission, restore: step.kind === "observe" });
        evidence.memoryAfter = structuredClone(await services.memory.list(thread.context));
        if (evidence.result.information) pending.set(key, evidence.result.information);
        else pending.delete(key);
      } catch (error) {
        const scenario = error instanceof ScenarioUnfulfilled;
        evidence.error = { kind: scenario ? "scenario_unfulfilled" : "execution_error",
          message: scenario ? error.message : "模型、存储或执行发生错误；未将原始供应商/数据库错误写入报告。" };
        result.execution = scenario ? "blocked" : "error";
      }
      evidence.checks = checkRules(step.checks, evidence, result.steps);
      if (evidence.error) break;
    }
  } catch {
    result.execution = "error";
    result.setupError = "初始数据或 Agent 配置未能准备完成；没有把本例当作行为通过。";
  } finally {
    try { await services.cleanup(Object.values(contexts), [...threads.values()]); }
    catch { result.cleanupError = "本次隔离测试数据未确认清理完成，请按报告中的 eval 用户归属核对；没有重试模型。"; result.execution = "error"; }
  }
  const checks = result.steps.flatMap((step) => step.checks);
  result.automatic = result.execution === "blocked" || checks.some((entry) => entry.verdict === "fail") ? "fail"
    : result.execution === "error" || !checks.length || checks.some((entry) => entry.verdict === "indeterminate") ? "indeterminate" : "pass";
  return result;
}
