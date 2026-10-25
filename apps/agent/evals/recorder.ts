import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, ToolMessage } from "langchain";
import type { StepEvidence } from "./contracts.ts";
import { isGraphInterrupt } from "@langchain/langgraph";

export class EvaluationRecorder extends BaseCallbackHandler {
  name = "support-behavior-evaluation";
  constructor(private readonly evidence: StepEvidence) { super(); }
  private toolRuns = new Map<string, { name: string; callId?: string }>();

  override handleChatModelStart(...args: Parameters<NonNullable<BaseCallbackHandler["handleChatModelStart"]>>) {
    const [, batches, id, , , tags, metadata] = args;
    this.evidence.attempts.push({ id, kind: metadata?.lc_source === "summarization" || tags?.includes("summarization") ? "summary" : "main",
      inputs: (batches[0] ?? []).map((message) => ({ role: message.type, text: message.text })), status: "started" });
  }
  override handleLLMEnd(...args: Parameters<NonNullable<BaseCallbackHandler["handleLLMEnd"]>>) {
    const [output, id] = args;
    const attempt = this.evidence.attempts.find((entry) => entry.id === id);
    if (!attempt) return;
    attempt.status = "completed";
    const generation = output.generations[0]?.[0];
    if (!generation || !("message" in generation) || !AIMessage.isInstance(generation.message)) return;
    const message = generation.message;
    const usage = message.usage_metadata;
    if (usage && [usage.input_tokens, usage.output_tokens, usage.total_tokens].every((value) => Number.isFinite(value))) {
      attempt.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens };
    }
    if (attempt.kind === "main") for (const call of message.tool_calls ?? []) {
      this.evidence.proposedTools.push({ name: call.name, callId: call.id, args: call.args });
    }
  }
  override handleLLMError(...args: Parameters<NonNullable<BaseCallbackHandler["handleLLMError"]>>) {
    const attempt = this.evidence.attempts.find((entry) => entry.id === args[1]);
    if (attempt) attempt.status = "error";
  }
  override handleToolStart(...args: Parameters<NonNullable<BaseCallbackHandler["handleToolStart"]>>) {
    const [serialized, , id, , , , runName, toolCallId] = args;
    const name = runName ?? ("name" in serialized && typeof serialized.name === "string" ? serialized.name : undefined) ?? serialized.id.at(-1) ?? "unknown";
    this.toolRuns.set(id, { name, callId: toolCallId });
  }
  override handleToolEnd(...args: Parameters<NonNullable<BaseCallbackHandler["handleToolEnd"]>>) {
    const [output, id] = args;
    const run = this.toolRuns.get(id);
    if (!run) return;
    let result: unknown = output;
    let error = false;
    if (ToolMessage.isInstance(output)) {
      result = output.text;
      error = output.status === "error";
    }
    if (typeof result === "string") {
      try { result = JSON.parse(result); } catch { /* 文本工具输出仍按原值记录。 */ }
    }
    this.evidence.executedTools.push({ ...run, result, error });
  }
  override handleToolError(...args: Parameters<NonNullable<BaseCallbackHandler["handleToolError"]>>) {
    const run = this.toolRuns.get(args[1]);
    // interrupt 也可能进入此 callback；没有成功回执，不能据此认定工具已经失败或成功。
    if (run) this.evidence.executedTools.push({ ...run, error: !isGraphInterrupt(args[0]), result: { status: isGraphInterrupt(args[0]) ? "interrupted" : "no_success_receipt" } });
  }
}
