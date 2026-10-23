import { toolCallLimitMiddleware } from "langchain";

export interface ToolCallLimits {
  runLimit?: number;
  threadLimit?: number;
}

export function createToolCallLimitMiddleware(options: ToolCallLimits = {}) {
  const runLimit = options.runLimit ?? 4;
  const threadLimit = options.threadLimit ?? 40;
  if (!Number.isSafeInteger(runLimit) || !Number.isSafeInteger(threadLimit) ||
    runLimit < 1 || threadLimit < runLimit) {
    throw new Error("调用预算配置错误：工具上限必须为正整数，且会话上限不得小于每轮上限。");
  }
  // 所有工具共享预算；error 策略在执行前拒绝超限批次，不注入伪成功答案。
  return toolCallLimitMiddleware({ runLimit, threadLimit, exitBehavior: "error" });
}
