import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export function loadAgentEnv(): void {
  // 模型与 checkpoint 共用同一应用配置，环境中已有的变量优先。
  const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(envPath)) loadEnvFile(envPath);
}
