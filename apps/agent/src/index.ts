import { createSupportAgent } from "./agent.ts";
import { createModel } from "./model.ts";
import { createInterface } from "node:readline";
import { MemorySaver } from "@langchain/langgraph";
import { chat } from "./chat.ts";

async function main(): Promise<void> {
  // 配置读取和校验在函数调用时执行，抛错会进入 main().catch。
  const model = createModel();
  // 一个进程复用同一个 Agent 与 saver；每轮通过 thread_id 恢复会话状态。
  const agent = createSupportAgent(model, new MemorySaver());
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    await chat(agent, lines, undefined, process.argv.slice(2).includes("--debug"));
  } finally {
    lines.close();
  }
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
