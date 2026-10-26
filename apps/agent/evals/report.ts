import { z } from "zod";
import { redactPii } from "../src/agent/middleware/pii.ts";
import type { CaseResult } from "./contracts.ts";

export interface BehaviorReport {
  schemaVersion: 1; datasetVersion: string; datasetHash: string; createdAt: string;
  environment: Record<string, unknown>; selection: { caseIds: string[]; repeat: number };
  results: CaseResult[];
  runError?: string;
  comparison?: Array<{ id: string; repetition: number; automatic: "regressed" | "improved" | "unchanged" | "not_comparable"; reason?: string }>;
}
const baselineSchema = z.object({
  schemaVersion: z.literal(1), datasetVersion: z.string(), datasetHash: z.string(),
  selection: z.object({ caseIds: z.array(z.string()), repeat: z.number().int().positive() }),
  results: z.array(z.object({ id: z.string(), repetition: z.number().int().positive(), caseHash: z.string(),
    automatic: z.enum(["pass", "fail", "indeterminate"]), execution: z.enum(["ok", "error", "blocked"]) })),
});

export function compareReports(report: BehaviorReport, baseline: unknown): NonNullable<BehaviorReport["comparison"]> {
  const previous = baselineSchema.parse(baseline);
  return report.results.map((current) => {
    const old = previous.results.find((entry) => entry.id === current.id && entry.repetition === current.repetition);
    let reason: string | undefined;
    if (previous.datasetHash !== report.datasetHash || previous.datasetVersion !== report.datasetVersion) reason = "数据集版本或内容不同";
    else if (previous.selection.repeat !== report.selection.repeat) reason = "采样次数不同";
    else if (!old || old.caseHash !== current.caseHash) reason = "缺少相同用例/轮次或用例内容改变";
    else if (old.automatic === "indeterminate" || current.automatic === "indeterminate" || old.execution === "error" || current.execution === "error") reason = "存在执行错误或未判定项";
    return { id: current.id, repetition: current.repetition, automatic: reason ? "not_comparable"
      : old!.automatic === current.automatic ? "unchanged" : current.automatic === "pass" ? "improved" : "regressed", ...(reason ? { reason } : {}) };
  });
}

// 自动检查先用真实证据判定，再脱敏输出；不能用已脱敏的报告伪造隐私检查通过。
export function sanitizeArtifact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, "[REDACTED_SECRET]");
    return redactPii(text).replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[REDACTED_DATABASE_URL]")
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
      .replace(/((?:api[_ -]?key|password|密码|access[_ -]?token)\s*[:=：]\s*)[^\s"'<>]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((entry: unknown) => sanitizeArtifact(entry, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeArtifact(entry, secrets)]));
  return value;
}

function cell(value: string) { return value.replaceAll("|", "\\|").replaceAll("\n", " "); }
function quote(value: string) { return value.split("\n").map((line) => `    ${line}`).join("\n"); }
export function markdownReport(report: BehaviorReport): string {
  const results = report.results;
  const passed = results.filter((entry) => entry.automatic === "pass").length;
  const failed = results.filter((entry) => entry.automatic === "fail").length;
  const unknown = results.filter((entry) => entry.automatic === "indeterminate").length;
  const attempts = results.flatMap((entry) => entry.steps.flatMap((step) => step.attempts));
  const usage = attempts.filter((entry) => entry.usage).map((entry) => entry.usage!);
  const lines = ["# 客服行为评估报告", "", `运行时间：${report.createdAt}`, `数据集：${report.datasetVersion}`, "",
    `已执行 ${results.length}/${report.selection.caseIds.length * report.selection.repeat} 个样本；未执行项不计为通过。${report.runError ? `运行问题：${report.runError}` : ""}`,
    `自动检查：${passed} 通过，${failed} 失败，${unknown} 未判定。语义质量：全部待人工复核，不代表生产验收通过。`,
    `模型尝试：${attempts.length}（含摘要 ${attempts.filter((entry) => entry.kind === "summary").length}）；usage 覆盖 ${usage.length}/${attempts.length}。`,
    `已报告 Token 小计：${usage.reduce((sum, entry) => sum + entry.totalTokens, 0)}；缺失不估造，未计算供应商费用。`, "",
    "预置记忆仅用于准备场景；没有把预期结果、检查规则或复核标准传给 Agent。", "",
    "| 用例 | 轮次 | 执行 | 自动检查 | 语义复核 |", "|---|---:|---|---|---|"];
  for (const result of results) lines.push(`| ${cell(result.id)} | ${result.repetition} | ${result.execution} | ${result.automatic} | 待复核 |`);
  if (report.comparison) {
    lines.push("", "## 基线比较", "", "只比较相同数据集、用例与采样次数的自动检查；不自动判断语义质量提升。", "");
    for (const entry of report.comparison) lines.push(`- ${entry.id} #${entry.repetition}：${entry.automatic}${entry.reason ? `（${entry.reason}）` : ""}`);
  }
  for (const result of results) {
    lines.push("", `## ${result.id} #${result.repetition}`, "", result.description, "", "人工复核标准：", "");
    for (const criterion of result.review) lines.push(`- [ ] ${criterion}`);
    if (result.cleanupError) lines.push("", result.cleanupError, `隔离身份：${result.actorIds.join(", ")}`);
    if (result.setupError) lines.push("", result.setupError);
    for (const step of result.steps) {
      lines.push("", `### 步骤 ${step.index + 1} · ${step.actor}/${step.thread} · ${step.kind}`, "");
      if (step.input) lines.push("输入：", "", quote(step.input), "");
      if (step.error) lines.push(`执行问题：${step.error.kind} — ${step.error.message}`, "");
      if (step.result) lines.push(`结果状态：${step.result.status}`, "", "最终回答：", "", quote(step.result.answer || "（无最终正文）"), "");
      lines.push(`提出工具：${step.proposedTools.map((entry) => entry.name).join(", ") || "无"}`, `记忆条目：${step.memoryBefore.length} → ${step.memoryAfter.length}`, "");
      for (const check of step.checks) lines.push(`- ${check.verdict} · ${cell(JSON.stringify(check.rule))} · 实际 ${JSON.stringify(check.observed)}`);
    }
  }
  lines.push("", "完整的模型输入、工具参数/回执、记忆快照和版本信息见同目录 report.json。", "",
    "复核结果可填写 reviews.json；本版本不自动将人工记录合并成验收结论。", "");
  return lines.join("\n");
}
