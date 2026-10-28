import { AIMessage, createMiddleware } from "langchain";
import { z } from "zod";
import { interactionContextSchema } from "../interactions/agent.ts";
import { currentCapabilities,runDetailsSchema } from "../knowledge/runtime.ts";

// 仅 afterAgent 正常完成才写入；恢复对账只信与当前请求 ID 匹配的回执。
export const receiptSchema = z.object({ requestId: z.string(), runId: z.string(), answer: z.string().min(1), details:runDetailsSchema.optional() });
export function conversationReceiptMiddleware() {
  return createMiddleware({
    name: "SupportCompletionReceipt",
    contextSchema: z.object({ interaction: interactionContextSchema.optional() }),
    stateSchema: z.object({ supportCompletionReceipt: receiptSchema.optional() }),
    afterAgent: async (state, runtime) => {
      const capabilities=currentCapabilities();
      if(capabilities&&await capabilities.client.scope()!==capabilities.revision)throw new Error("知识范围已失效，请新建会话。");
      const interaction = (runtime.context as { interaction?: { requestId?: string; runId?: string } } | undefined)?.interaction;
      const last = state.messages.at(-1);
      if(capabilities&&last&&AIMessage.isInstance(last)&&!last.tool_calls?.length&&last.text.trim()){
        const cited=[...last.text.matchAll(/\[K:([^\]]+)\]/g)].map(match=>`K:${match[1]}`);
        if(cited.some(id=>!capabilities.details.citations.some(c=>c.id===id)))throw new Error("回答包含未核对的知识引用。");
        capabilities.details.citations=capabilities.details.citations.filter(c=>c.kind==="web"||cited.includes(c.id));
      }
      if (interaction?.requestId && interaction.runId && last && AIMessage.isInstance(last) && !last.tool_calls?.length && last.text.trim()) {
        return { supportCompletionReceipt: { requestId: interaction.requestId, runId: interaction.runId, answer: last.text, ...(capabilities?{details:capabilities.details}:{}) } };
      }
    },
  });
}
