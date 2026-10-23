import { createSupportAgent } from "./agent/agent.ts";
import { createModel } from "./config/model.ts";
import { createInterface } from "node:readline";
import { chat, parseCliOptions } from "./cli/chat.ts";
import { createCheckpointer } from "./config/checkpoint.ts";

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const model = createModel();
  const checkpointer = await createCheckpointer();
  // 一个进程复用一个数据库连接池；正常结束或执行失败都释放连接。
  try {
    const agent = createSupportAgent(model, checkpointer);
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
}

main().catch((error: unknown) => {
  // 不打印原始供应商错误、请求或堆栈，避免其中包含密钥、地址等敏感配置。
  if (error instanceof Error && /^(缺少 |OPENAI_|模型未返回|数据库配置|数据库初始化|启动参数|会话恢复)/.test(error.message)) {
    console.error("[agent]", error.message);
  } else {
    console.error("[agent] 执行失败，请检查模型服务或 PostgreSQL；本轮可能未保存完整结果，不会自动重试。");
  }
  process.exitCode = 1;
});
