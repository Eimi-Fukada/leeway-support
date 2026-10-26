import { AIMessage, createMiddleware } from "langchain";
import { z } from "zod";
import { interactionContextSchema } from "../interactions/agent.ts";

// 仅 afterAgent 正常完成才写入；恢复对账只信与当前请求 ID 匹配的回执。
export const receiptSchema = z.object({ requestId: z.string(), runId: z.string(), answer: z.string().min(1) });
export function conversationReceiptMiddleware() {
  return createMiddleware({
    name: "SupportCompletionReceipt",
    contextSchema: z.object({ interaction: interactionContextSchema.optional() }),
    stateSchema: z.object({ supportCompletionReceipt: receiptSchema.optional() }),
    afterAgent: (state, runtime) => {
      const interaction = (runtime.context as { interaction?: { requestId?: string; runId?: string } } | undefined)?.interaction;
      const last = state.messages.at(-1);
      if (interaction?.requestId && interaction.runId && last && AIMessage.isInstance(last) && !last.tool_calls?.length && last.text.trim()) {
        return { supportCompletionReceipt: { requestId: interaction.requestId, runId: interaction.runId, answer: last.text } };
      }
    },
  });
}
