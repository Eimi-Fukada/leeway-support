import { createAgent } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import {
  createSummaryMiddleware,
  type SummaryOptions,
} from "./middleware/summarization.ts";
import { createPiiMiddleware } from "./middleware/pii.ts";
import { createModelRetryMiddleware } from "./middleware/model-retry.ts";
import {
  createModelCallLimitMiddleware,
  type ModelCallLimits,
} from "./middleware/model-call-limit.ts";
import {
  createToolCallLimitMiddleware,
  type ToolCallLimits,
} from "./middleware/tool-call-limit.ts";
import {
  agentContextSchema,
  createMemoryMiddleware,
  memoryTools,
} from "../memory/agent.ts";
import type { MemoryService } from "../memory/service.ts";

export interface CallLimits {
  model?: ModelCallLimits;
  tool?: ToolCallLimits;
}

// Agent 定义：模型由入口传入，ChatOpenAI 和 fakeModel 都实现 BaseChatModel。
// 此模块不导入 model.ts，因此创建模拟 Agent 不会加载 .env 或校验真实凭证。
export function createSupportAgent(
  model: BaseChatModel,
  checkpointer?: BaseCheckpointSaver,
  summary: SummaryOptions = {},
  limits: CallLimits = {},
  memory?: MemoryService,
) {
  // createAgent 基于 LangGraph 构建执行流程；这里先不手写 StateGraph。
  // 仅在注入记忆服务时开放内部记忆工具；当前没有业务工具。
  return createAgent({
    model,
    tools: memory ? memoryTools(memory) : [],
    contextSchema: agentContextSchema,
    checkpointer,
    // 主模型预算先检查，耗尽时不再触发摘要；工具预算在 afterModel、工具执行前检查。
    middleware: [
      createModelCallLimitMiddleware(limits.model),
      createPiiMiddleware(),
      createSummaryMiddleware(model, summary),
      createModelRetryMiddleware(),
      ...(memory ? [createMemoryMiddleware(memory)] : []),
      createToolCallLimitMiddleware(limits.tool),
    ],
    systemPrompt:
      "你是 Leeway Support 的智能客服助手，使用简洁的中文回答。" +
      "目前没有接入知识库或业务工具，请明确说明能力边界，" +
      "不要编造订单、任务状态、产品规则或声称已经执行操作。",
  });
}
