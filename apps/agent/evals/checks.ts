import type { CheckResult, Rule, StepEvidence } from "./contracts.ts";

export function checkRules(rules: Rule[], evidence: StepEvidence, history: readonly StepEvidence[] = [evidence]): CheckResult[] {
  return rules.map((rule) => {
    // 请求/存储失败不能按 0 次工具、空记忆等条件冒充通过。
    if (evidence.error) return { rule, verdict: "indeterminate", observed: evidence.error.kind };
    let observed: unknown;
    let passed: boolean;
    if (rule.kind === "status") {
      observed = evidence.result?.status;
      passed = !!observed && rule.allowed.includes(observed as "completed" | "waiting_for_input");
    } else if (rule.kind === "input_excludes" || rule.kind === "input_includes") {
      if (!evidence.attempts.length) return { rule, verdict: "indeterminate", observed: "没有模型输入证据" };
      const contains = evidence.attempts.some((entry) => entry.inputs.some((message) => message.text.includes(rule.text)));
      observed = contains;
      passed = rule.kind === "input_includes" ? contains : !contains;
    } else if (rule.kind === "answer_excludes") {
      if (!evidence.result || evidence.result.status !== "completed") return { rule, verdict: "indeterminate", observed: "没有完整回答" };
      observed = evidence.result.answer.includes(rule.text) || evidence.streamedText.includes(rule.text);
      passed = !observed;
    } else {
      let value: number;
      if (rule.kind === "memory_count") value = evidence.memoryAfter.length;
      else if (rule.kind === "summary_calls") value = (rule.scope === "case" ? history : [evidence])
        .flatMap((step) => step.attempts).filter((entry) => entry.kind === "summary").length;
      else if (rule.kind === "model_attempts") value = evidence.attempts.length;
      else if (rule.kind === "tool_calls") value = evidence.proposedTools.filter((entry) => entry.name === rule.name).length;
      else value = evidence.executedTools.filter((entry) => {
        if (entry.name !== rule.name || entry.error || !entry.result || typeof entry.result !== "object") return false;
        const status = (entry.result as { status?: string }).status;
        return ["saved", "updated", "forgotten", "answered", "cancelled"].includes(status ?? "");
      }).length;
      observed = value;
      passed = (rule.min === undefined || value >= rule.min) && (rule.max === undefined || value <= rule.max);
      if (rule.kind === "tool_calls" && !evidence.attempts.length && evidence.kind !== "observe") {
        return { rule, verdict: "indeterminate", observed: "没有模型调用证据" };
      }
    }
    return { rule, verdict: passed ? "pass" : "fail", observed };
  });
}
