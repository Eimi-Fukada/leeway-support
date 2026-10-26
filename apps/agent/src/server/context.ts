import "server-only";
import { loadAgentEnv } from "../config/env.ts";
import { localSupportContext } from "../support-context.ts";

export function developmentContext() {
  loadAgentEnv();
  const user = process.env.SUPPORT_DEV_USER?.trim();
  if (!user) throw new Error("请通过 pnpm ui -- --user <开发用户ID> 启动，或在服务端配置 SUPPORT_DEV_USER。");
  return localSupportContext(user);
}
