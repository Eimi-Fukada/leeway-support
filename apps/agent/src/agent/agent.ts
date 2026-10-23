import { createAgent } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

// Agent 定义：模型由入口传入，ChatOpenAI 和 fakeModel 都实现 BaseChatModel。
// 此模块不导入 model.ts，因此创建模拟 Agent 不会加载 .env 或校验真实凭证。
export function createSupportAgent(model: BaseChatModel, checkpointer?: BaseCheckpointSaver) {
  // createAgent 基于 LangGraph 构建执行流程；这里先不手写 StateGraph。
  // 空工具列表表示目前只能回答问题，不能查询真实任务或执行业务操作。
  return createAgent({
    model,
    tools: [],
    checkpointer,
    systemPrompt:
      "你是 Leeway Support 的智能客服助手，使用简洁的中文回答。" +
      "目前没有接入知识库或业务工具，请明确说明能力边界，" +
      "不要编造订单、任务状态、产品规则或声称已经执行操作。",
  });
}
