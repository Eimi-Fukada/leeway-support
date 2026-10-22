import { createSupportAgent } from "./agent.ts";
import { createModel } from "./model.ts";
import { runSupportCli } from "./cli-run.ts";

async function main(): Promise<void> {
  // 配置读取和校验在函数调用时执行，抛错会进入 main().catch。
  const model = createModel();
  const agent = createSupportAgent(model);
  const question = "你好，请简要介绍你现在能够做什么，以及还不能做什么。";
  console.log("[用户]", question);
  // 一次主 Agent 流式执行；逐步输出片段，最终结果也从这次流取得。
  await runSupportCli(agent, question, undefined, process.argv.slice(2).includes("--debug"));
}

main().catch((error: unknown) => {
  // 不打印原始供应商错误、请求或堆栈，避免其中包含密钥、地址等敏感配置。
  if (error instanceof Error && /^(缺少 |OPENAI_|模型未返回)/.test(error.message)) {
    console.error("[agent]", error.message);
  } else {
    console.error("[agent] 模型调用失败，请检查网络、密钥、余额以及模型/接口模式和流式响应是否受支持。");
  }
  process.exitCode = 1;
});
