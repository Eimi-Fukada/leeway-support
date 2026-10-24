import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import { parseCliOptions } from "../cli/chat.ts";
import { createSupportAgent } from "../agent/agent.ts";
import { createModel } from "../config/model.ts";
import { createCheckpointer } from "../config/checkpoint.ts";
import { createMemory } from "../config/memory.ts";
import { createDatabasePool } from "../config/database.ts";
import { createTracing } from "../config/tracing.ts";
import { loadAgentEnv } from "../config/env.ts";
import { InformationService } from "../interactions/service.ts";
import { localSupportContext, memoryScope, checkpointThreadId } from "../support-context.ts";
import { SupportUiAgent } from "./adapter.ts";

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  if (!options.userId || options.threadId || options.debug) throw new Error("UI 启动请使用 --user <开发用户ID>。");
  const support = localSupportContext(options.userId);
  loadAgentEnv();
  const model = createModel();
  const cleanups: Array<() => Promise<unknown>> = [];
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  }
  try {
    const tracing = createTracing();
    cleanups.push(() => tracing.flush());
    const pool = createDatabasePool();
    cleanups.push(() => pool.end());
    const checkpointer = await createCheckpointer();
    cleanups.push(() => checkpointer.end());
    const memory = await createMemory();
    cleanups.push(() => memory.close());
    const information = new InformationService(pool);
    await information.setup();
    const agent = createSupportAgent(model, checkpointer, {}, {}, memory.service, information).withConfig({ callbacks: tracing.callbacks });
    // 每次请求独立的 AG-UI adapter；身份固定来自服务端启动参数，不读取浏览器 userId。
    const runtime = new CopilotRuntime({ agents: () => ({ support: new SupportUiAgent(agent, information, support) }) });
    const listener = createCopilotNodeListener({ runtime, basePath: "/api/copilotkit" });
    const server = createServer((request, response) => {
      void (async () => {
        // 本地调试入口；同源页面访问，不开启跨域，也不宣称具备业务身份认证。
        if (request.headers.host !== "127.0.0.1:3100" ||
          (request.headers.origin && request.headers.origin !== "http://127.0.0.1:3100")) {
          response.writeHead(403).end(); return;
        }
        const url = new URL(request.url ?? "/", "http://127.0.0.1:3100");
        if (url.pathname === "/api/session") {
          response.setHeader("Cache-Control", "no-store");
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ user: options.userId })); return;
        }
        if (url.pathname.startsWith("/api/information/")) {
          try {
            if (request.method !== "GET") { response.writeHead(405).end(); return; }
            const id = url.pathname.split("/").at(-1)!;
            const thread = url.searchParams.get("thread") ?? "";
            if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{1,128}$/.test(thread)) throw new Error();
            const form = await information.get(memoryScope(support), checkpointThreadId(thread, support), id);
            response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            response.end(JSON.stringify(form));
          } catch { response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "表单不可用" })); }
          return;
        }
        if (url.pathname.startsWith("/api/copilotkit")) { await listener(request, response); return; }
        vite.middlewares(request, response);
      })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const vite = await createViteServer({ configFile: false, root: fileURLToPath(new URL("../../web", import.meta.url)),
      envDir: false, plugins: [react()], server: { middlewareMode: true, hmr: { server }, allowedHosts: ["127.0.0.1"] }, appType: "spa" });
    cleanups.push(() => vite.close());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(3100, "127.0.0.1", resolve);
    });
    console.log(`客服调试页：http://127.0.0.1:3100（开发身份 ${options.userId}）`);
    process.once("SIGINT", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
  } catch (error) { await close(); throw error; }
}

main().catch(() => { console.error("[UI] 启动失败，请检查 --user、模型配置、数据库或端口 3100。"); process.exitCode = 1; });
