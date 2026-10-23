import { AIMessage, HumanMessage } from "langchain";
import { randomUUID } from "node:crypto";
import type { createSupportAgent } from "./agent.ts";
import { redactPii } from "./middleware/pii.ts";
import { markModelOutput, withRetryProgress } from "./middleware/model-retry.ts";
import { checkpointThreadId, validateSupportContext, type SupportContext } from "../support-context.ts";

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
): Promise<{ answer: string; elapsedMs: number; runId: string }> {
  if (!question.trim()) throw new Error("用户输入不能为空。");
  if (threadId !== undefined && !threadId.trim())
    throw new Error("会话标识不能为空。");
  // 提交 Graph 前脱敏，避免新输入原文先进入 checkpoint 或根 trace。
  question = redactPii(question);
  const support = context === undefined ? undefined : validateSupportContext(context);
  return withRetryProgress(async () => {
    const startedAt = performance.now();
    const runId = randomUUID();
    let answer = "";
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
        signal: AbortSignal.timeout(65_000),
        context: support ? { support } : {},
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
        // 当前是无工具的单模型 Agent，仅投影文本。
        // 增加工具/内部模型节点时，需重新定义哪些消息可以面向用户展示。
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
    if (!answer.trim()) throw new Error("模型未返回有效文本回答。");
    return { answer, elapsedMs: Math.round(performance.now() - startedAt), runId };
  });
}
