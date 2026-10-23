import { modelCallLimitMiddleware } from "langchain";

export interface ModelCallLimits {
  runLimit?: number;
  threadLimit?: number;
}

export function createModelCallLimitMiddleware(options: ModelCallLimits = {}) {
  const runLimit = options.runLimit ?? 6;
  const threadLimit = options.threadLimit ?? 60;
  if (!Number.isSafeInteger(runLimit) || !Number.isSafeInteger(threadLimit) ||
    runLimit < 1 || threadLimit < runLimit) {
    throw new Error("调用预算配置错误：模型上限必须为正整数，且会话上限不得小于每轮上限。");
  }
  // 官方计数是成功的主模型步骤，不是网络 attempts 或总费用。
  return modelCallLimitMiddleware({ runLimit, threadLimit, exitBehavior: "error" });
}
