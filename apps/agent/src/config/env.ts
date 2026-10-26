import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export function loadAgentEnv(): void {
  // Next 按应用目录加载环境文件；编译后的 chunk 路径不能用于定位源码旁的 .env。
  if (process.env.NEXT_RUNTIME) return;
  // 模型与 checkpoint 共用同一应用配置，环境中已有的变量优先。
  const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(envPath)) loadEnvFile(envPath);
}
