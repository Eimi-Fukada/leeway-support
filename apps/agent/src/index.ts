import { createSupportAgent } from "./agent.ts";
import { createModel } from "./model.ts";

async function main(): Promise<void> {
  // 配置读取和校验在函数调用时执行，抛错会进入 main().catch。
  const model = createModel();
  const agent = createSupportAgent(model);
  const question = "你好，请简要介绍你现在能够做什么，以及还不能做什么。";
  console.log("[用户]", question);
  console.log("[agent] 正在等待模型回答……");

  // invoke 执行一次完整 Agent 流程，返回包含输入和回答的 messages 状态。
  // 当前无工具、无持久记忆，每次启动都是一次独立对话。
  const result = await agent.invoke({
    messages: [{ role: "user", content: question }],
  });
  const answer = result.messages.at(-1);
  if (!answer || answer.type !== "ai" || !answer.text.trim()) {
    throw new Error("模型未返回有效文本回答，请检查所选模型与接口的兼容性。");
  }
  console.log("[客服]", answer.text);
}

main().catch((error: unknown) => {
  // 不打印原始供应商错误、请求或堆栈，避免其中包含密钥、地址等敏感配置。
  if (error instanceof Error && /^(缺少 |OPENAI_|模型未返回)/.test(error.message)) {
    console.error("[agent]", error.message);
  } else {
    console.error("[agent] 模型调用失败，请检查网络、密钥、余额以及模型/接口模式是否匹配。");
  }
  process.exitCode = 1;
});
