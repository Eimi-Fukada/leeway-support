import { createSupportAgent } from "./agent.ts";
import { observeAgent } from "./debug-run.ts";
import { createModel } from "./model.ts";

async function main(): Promise<void> {
  const agent = createSupportAgent(createModel());
  const question = "你好，请简要介绍你现在能够做什么，以及还不能做什么。";
  console.log("[用户]", question);
  await observeAgent(agent, question);
}

main().catch((error: unknown) => {
  // 配置校验信息由我们生成；不输出原始供应商错误、请求或堆栈。
  if (error instanceof Error && /^(缺少 |OPENAI_|模型未返回)/.test(error.message)) {
    console.error("[调试错误]", error.message);
  } else {
    console.error("[调试错误] 执行失败，请检查网络、模型配置及服务端是否支持流式响应。");
  }
  process.exitCode = 1;
});
