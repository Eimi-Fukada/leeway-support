import { createSupportAgent } from "./agent/agent.ts";
import { createModel } from "./config/model.ts";
import { createInterface } from "node:readline";
import { chat, parseCliOptions } from "./cli/chat.ts";
import { createCheckpointer } from "./config/checkpoint.ts";
import { loadAgentEnv } from "./config/env.ts";
import { createTracing } from "./config/tracing.ts";

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  loadAgentEnv();
  const tracing = createTracing();
  try {
    const model = createModel();
    const checkpointer = await createCheckpointer();
    // callbacks 通过框架传给各子节点；不更换 Agent 或托管运行环境。
    try {
      const agent = createSupportAgent(model, checkpointer).withConfig({ callbacks: tracing.callbacks });
      if (tracing.enabled) console.log("[追踪] LangSmith 已启用；上传记录不代表云端已验收。");
      let lines: ReturnType<typeof createInterface> | undefined;
      try {
        await chat(agent, () => {
          lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
          return lines;
        }, undefined, options.debug, options.threadId);
      } finally {
        lines?.close();
      }
    } finally {
      await checkpointer.end();
    }
  } finally {
    await tracing.flush();
  }
}

main().catch((error: unknown) => {
  // 不打印原始供应商错误、请求或堆栈，避免其中包含密钥、地址等敏感配置。
  if (error instanceof Error && /^(缺少 |OPENAI_|模型未返回|数据库配置|数据库初始化|启动参数|会话恢复|追踪配置|摘要配置|摘要失败)/.test(error.message)) {
    console.error("[agent]", error.message);
  } else {
    console.error("[agent] 执行失败，请检查模型服务或 PostgreSQL；本轮可能未保存完整结果，不会自动重试。");
  }
  process.exitCode = 1;
});
