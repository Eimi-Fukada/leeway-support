import { z } from "zod";
import type { MemoryRecord } from "../src/memory/service.ts";
import type { SupportRunResult } from "../src/interactions/service.ts";

const count = { min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative().optional() };
export const ruleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), allowed: z.array(z.enum(["completed", "waiting_for_input"])).min(1) }).strict(),
  z.object({ kind: z.literal("tool_calls"), name: z.string(), ...count }).strict(),
  z.object({ kind: z.literal("tool_successes"), name: z.string(), ...count }).strict(),
  z.object({ kind: z.literal("memory_count"), ...count }).strict(),
  z.object({ kind: z.literal("summary_calls"), scope: z.enum(["step", "case"]).optional(), ...count }).strict(),
  z.object({ kind: z.literal("model_attempts"), ...count }).strict(),
  z.object({ kind: z.literal("input_excludes"), text: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("input_includes"), text: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("answer_excludes"), text: z.string().min(1) }).strict(),
]);
const actor = z.enum(["a", "b"]).default("a");
const base = { actor, thread: z.string().regex(/^[a-z0-9_-]{1,40}$/), checks: z.array(ruleSchema).min(1) };
export const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,60}$/), category: z.string().min(1), description: z.string().min(1),
  seeds: z.array(z.object({ actor, content: z.string().min(1).max(1000) }).strict()).default([]),
  summary: z.object({ triggerTokens: z.number().int().positive(), keepMessages: z.number().int().min(2) }).strict().optional(),
  steps: z.array(z.discriminatedUnion("kind", [
    z.object({ ...base, kind: z.literal("message"), text: z.string().min(1) }).strict(),
    z.object({ ...base, kind: z.literal("cancel") }).strict(),
    z.object({ ...base, kind: z.literal("observe") }).strict(),
    z.object({ ...base, kind: z.literal("submit"), answers: z.array(z.object({
      labelPattern: z.string().min(1).max(100), text: z.string(), optionPattern: z.string().max(100).optional(),
    }).strict()).min(1) }).strict(),
  ])).min(1),
  review: z.array(z.string().min(1)).min(1),
}).strict();
export type BehaviorCase = z.infer<typeof caseSchema>;
export type BehaviorStep = BehaviorCase["steps"][number];
export type Rule = z.infer<typeof ruleSchema>;
export interface CheckResult { rule: Rule; verdict: "pass" | "fail" | "indeterminate"; observed: unknown }
export interface ModelAttempt {
  id: string; kind: "main" | "summary"; inputs: Array<{ role: string; text: string }>;
  status: "started" | "completed" | "error";
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}
export interface ToolEvidence { name: string; callId?: string; args?: unknown; result?: unknown; error?: boolean }
export interface StepEvidence {
  index: number; actor: "a" | "b"; thread: string; kind: BehaviorStep["kind"]; input?: string;
  result?: SupportRunResult; streamedText: string; attempts: ModelAttempt[];
  proposedTools: ToolEvidence[]; executedTools: ToolEvidence[];
  memoryBefore: MemoryRecord[]; memoryAfter: MemoryRecord[];
  checks: CheckResult[];
  error?: { kind: "execution_error" | "scenario_unfulfilled"; message: string };
}
export interface CaseResult {
  id: string; category: string; description: string; caseHash: string; repetition: number;
  actorIds: string[];
  execution: "ok" | "error" | "blocked";
  automatic: "pass" | "fail" | "indeterminate";
  semantic: "needs_review";
  review: string[]; steps: StepEvidence[]; cleanupError?: string;
  setupError?: string;
}
