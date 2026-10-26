import "server-only";
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";
import { createSupportAgent } from "../agent/agent.ts";
import { createModel } from "../config/model.ts";
import { createCheckpointer } from "../config/checkpoint.ts";
import { createMemory } from "../config/memory.ts";
import { createDatabasePool } from "../config/database.ts";
import { createTracing } from "../config/tracing.ts";
import { InformationService } from "../interactions/service.ts";
import { ConversationService } from "../conversations/service.ts";
import { SupportUiAgent } from "../ui/adapter.ts";
import { developmentContext } from "./context.ts";

async function createRuntime() {
  const support = developmentContext();
  const model = createModel();
  const cleanups: Array<() => Promise<unknown>> = [];
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
    const conversation = new ConversationService(pool);
    await conversation.setup();
    const agent = createSupportAgent(model, checkpointer, {}, {}, memory.service, information)
      .withConfig({ callbacks: tracing.callbacks });
    const runtime = new CopilotRuntime({
      agents: () => ({ support: new SupportUiAgent(agent, information, support, conversation) }),
    });
    return {
      support, agent, information, conversation,
      handle: createCopilotRuntimeHandler({ runtime, basePath: "/api/copilotkit" }),
      flush: () => tracing.flush(),
    };
  } catch {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    throw new Error("客服服务初始化失败，请检查模型、数据库和追踪配置。");
  }
}

// 跨路由和开发热更新复用初始化 Promise；并发首请求不重复建池，构建时不连接数据库。
const shared = globalThis as typeof globalThis & { supportRuntime?: Promise<Awaited<ReturnType<typeof createRuntime>>> };
export function getSupportRuntime() {
  shared.supportRuntime ??= createRuntime().catch((error: unknown) => {
    delete shared.supportRuntime;
    throw error;
  });
  return shared.supportRuntime;
}
