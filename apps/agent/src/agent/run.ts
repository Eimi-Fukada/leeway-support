import { AIMessage, HumanMessage } from "langchain";
import { randomUUID } from "node:crypto";
import type { createSupportAgent } from "./agent.ts";
import { redactPii } from "./middleware/pii.ts";
import { markModelOutput, withRetryProgress } from "./middleware/model-retry.ts";
import { checkpointThreadId, memoryScope, validateSupportContext, type SupportContext } from "../support-context.ts";
import type { InformationBackend, CompletedRun } from "../interactions/service.ts";
import { InformationError, type InformationSubmission } from "../interactions/contracts.ts";

export type SupportRunEvent =
  | { type: "text"; text: string; node: string }
  | { type: "node-update"; node: string };

// Agent 执行：不依赖终端展示，最终结果来自同一次流。
export async function runSupportAgent(
  agent: ReturnType<typeof createSupportAgent>,
  question: string,
  onEvent: (event: SupportRunEvent) => void = () => {},
  threadId?: string,
  context?: SupportContext,
  interaction?: { service: InformationBackend; submission?: InformationSubmission; signal?: AbortSignal },
): Promise<CompletedRun> {
  if (!question.trim()) throw new Error("用户输入不能为空。");
  if (threadId !== undefined && !threadId.trim())
    throw new Error("会话标识不能为空。");
  // 提交 Graph 前脱敏，避免新输入原文先进入 checkpoint 或根 trace。
  question = redactPii(question);
  const support = context === undefined ? undefined : validateSupportContext(context);
  const execute = async (): Promise<CompletedRun> => {
    const scope = interaction ? memoryScope(validateSupportContext(support)) : "";
    const savedThread = threadId ? checkpointThreadId(threadId, support) : "";
    if (interaction) {
      if (!savedThread) throw new InformationError("需要明确的会话标识。");
      if (interaction.signal?.aborted) throw new InformationError("本轮已取消。");
      // 与 CLI 相同，只继续已完成的会话；在接受表单前检查，不自动重放未知副作用。
      const previous = await agent.graph.getState({ configurable: { thread_id: savedThread } });
      if (previous.next.length || previous.tasks?.some((task) => task.error || task.interrupts?.length))
        throw new InformationError("会话存在未完成步骤，请新建会话。");
      if (interaction.submission) {
        const accepted = await interaction.service.accept(scope, savedThread, interaction.submission);
        if ("replay" in accepted) return accepted.replay;
        question = accepted.question;
      }
      await interaction.service.begin(scope, savedThread);
    }
    return withRetryProgress(async () => {
      const startedAt = performance.now();
      const runId = randomUUID();
      let answer = "";
      try {
        const stream = await agent.withConfig({
          runId,
          runName: "support-turn",
          tags: ["leeway-support"],
          callbacks: [{ name: "support-stream-progress", handleLLMNewToken: () => { markModelOutput(); } }],
          metadata: { ...(threadId ? { thread_id: threadId } : {}) },
        }).stream(
          { messages: [new HumanMessage({ id: randomUUID(), content: question })] },
          {
            streamMode: ["messages", "updates", "values"],
            // 包含摘要、主回答和有限退避的整轮截止时间。
            signal: interaction?.signal ? AbortSignal.any([interaction.signal, AbortSignal.timeout(65_000)]) : AbortSignal.timeout(65_000),
            context: { ...(support ? { support } : {}), ...(interaction ? { interaction: { runId } } : {}) },
            ...(threadId === undefined
              ? {}
              : { configurable: { thread_id: checkpointThreadId(threadId, support) } }),
          },
        );

        for await (const [mode, data] of stream) {
          if (mode === "messages") {
            const [message, metadata] = data;
            // messages 流也可能包含 ToolMessage；工具结果和参数不能当作客服正文。
            if (message.type !== "ai") continue;
            // 摘要是内部模型调用，即使供应商产生片段，也不能混进客服正文。
            if (metadata.lc_source === "summarization" || metadata.tags?.includes("nostream")) continue;
            // 工具调用的参数与结果有独立投影；这里只输出 AI 的文本。
            if (message.text) {
              onEvent({
                type: "text",
                text: message.text,
                node: metadata.langgraph_node ?? "model",
              });
            }
          } else if (mode === "updates") {
            for (const node of Object.keys(data))
              onEvent({ type: "node-update", node });
          } else if (mode === "values") {
            const last = data.messages.at(-1);
            answer = last && AIMessage.isInstance(last) && !last.tool_calls?.length ? last.text : "";
          }
        }

        // 片段仅供过程展示；流正常耗尽且最终状态有效，才返回成功结果。
        if (interaction?.signal?.aborted) throw new InformationError("本轮已取消，表单不可提交。");
        if (!answer.trim()) throw new Error("模型未返回有效文本回答。");
        const information = interaction ? await interaction.service.finish(scope, savedThread, runId, true) : undefined;
        const result: CompletedRun = { answer, elapsedMs: Math.round(performance.now() - startedAt), runId, ...(information ? { information } : {}) };
        if (interaction?.submission) await interaction.service.record(scope, savedThread, interaction.submission, result);
        return result;
      } catch (error) {
        if (interaction) await interaction.service.finish(scope, savedThread, runId, false).catch(() => {});
        throw error;
      }
    });
  };
  return interaction
    ? interaction.service.withThread(memoryScope(validateSupportContext(support)), checkpointThreadId(threadId ?? "", support), execute)
    : execute();
}
