import { ChatOpenAI } from "@langchain/openai";
import { loadAgentEnv } from "./env.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少 ${name}，请在 apps/agent/.env 或运行环境中配置。`);
  }
  return value;
}

// 静态 import 只加载定义；调用此函数时才读取配置、校验并创建真实模型。
export function createModel(): ChatOpenAI {
  // 由同目录 env.ts 定位 apps/agent/.env，不依赖从哪个目录启动。
  // 部署时可以直接注入环境变量；Node 不会用文件覆盖已有变量。
  loadAgentEnv();

  const apiKey = required("OPENAI_API_KEY");
  const modelName = required("OPENAI_MODEL");
  const baseURL = process.env.OPENAI_BASE_URL?.trim() || undefined;
  const apiMode = process.env.OPENAI_API_MODE?.trim() || "responses";

  if (apiMode !== "responses" && apiMode !== "chat-completions") {
    throw new Error("OPENAI_API_MODE 只能是 responses 或 chat-completions。");
  }

  if (baseURL) {
    try {
      const url = new URL(baseURL);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error();
      if (url.username || url.password || url.search || url.hash) throw new Error();
      if (/\/(responses|chat\/completions)\/?$/.test(url.pathname)) throw new Error();
    } catch {
      throw new Error("OPENAI_BASE_URL 应为 http/https API 基础地址，不能带凭证、查询参数或完整请求路径。");
    }
  }

  // 创建实例不会发请求，Agent 执行时才调用模型。
  return new ChatOpenAI({
    apiKey,
    model: modelName,
    configuration: { baseURL },
    useResponsesApi: apiMode === "responses",
    timeout: 60_000,
    maxRetries: 0, // 学习阶段一次调用一次尝试，失败立即反馈，便于定位。
  });
}
