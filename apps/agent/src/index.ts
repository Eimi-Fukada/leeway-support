import { createSupportAgent } from "./agent/agent.ts";
import { createModel } from "./config/model.ts";
import { createInterface } from "node:readline";
import { chat, parseCliOptions } from "./cli/chat.ts";
import { createCheckpointer } from "./config/checkpoint.ts";
import { loadAgentEnv } from "./config/env.ts";
import { createTracing } from "./config/tracing.ts";
import { createMemory } from "./config/memory.ts";
import { localSupportContext } from "./support-context.ts";

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (!options.userId) throw new Error("启动参数无效：请使用 --user <开发用户ID> 明确指定本地身份；这不是生产登录认证。");
  const context = localSupportContext(options.userId);
  loadAgentEnv();
  const tracing = createTracing();
  try {
    const model = createModel();
    const checkpointer = await createCheckpointer();
    let memory: Awaited<ReturnType<typeof createMemory>> | undefined;
    // callbacks 通过框架传给各子节点；不更换 Agent 或托管运行环境。
    try {
      memory = await createMemory();
      const agent = createSupportAgent(model, checkpointer, {}, {}, memory.service).withConfig({ callbacks: tracing.callbacks });
      console.log(`[本地开发身份] ${options.userId}；未来业务入口必须在服务端完成认证后提供 SupportContext。`);
      if (tracing.enabled) console.log("[追踪] LangSmith 已启用；上传记录不代表云端已验收。");
      let lines: ReturnType<typeof createInterface> | undefined;
      try {
        await chat(agent, () => {
          lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
          return lines;
        }, undefined, options.debug, options.threadId, context);
      } finally {
        lines?.close();
      }
    } finally {
      try { await memory?.close(); }
      finally { await checkpointer.end(); }
    }
  } finally {
    await tracing.flush();
  }
}

main().catch((error: unknown) => {
  // beforeModel/afterModel 的预算错误可能被框架包装，沿 cause 查找稳定的错误类型。
  let current = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (["ModelCallLimitMiddlewareError", "ToolCallLimitExceededError"].includes(current.name) ||
      current.constructor.name === "ToolCallLimitExceededError") {
      console.error("[agent] 已达到模型或工具调用上限，本轮未完成；不会继续执行，请检查会话预算。");
      process.exitCode = 1;
      return;
    }
    current = current.cause;
  }
  // 不打印原始供应商错误、请求或堆栈，避免其中包含密钥、地址等敏感配置。
  if (error instanceof Error && /^(缺少 |OPENAI_|模型未返回|数据库配置|数据库初始化|启动参数|会话恢复|追踪配置|摘要配置|摘要失败|调用预算配置|身份上下文|长期记忆)/.test(error.message)) {
    console.error("[agent]", error.message);
  } else {
    console.error("[agent] 执行失败，请检查模型服务或 PostgreSQL；本轮可能未保存完整结果，不会自动重试。");
  }
  process.exitCode = 1;
});
