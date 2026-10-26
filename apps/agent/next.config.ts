import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  // 这些 SDK 仅在 Node 服务端运行，保留其原生模块解析和单一状态实例。
  serverExternalPackages: ["@copilotkit/runtime", "@langchain/core", "@langchain/langgraph",
    "@langchain/langgraph-checkpoint-postgres", "@langchain/openai", "langchain", "langsmith", "pg"],
  poweredByHeader: false,
};
export default config;
