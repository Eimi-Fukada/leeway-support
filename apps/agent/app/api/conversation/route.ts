import { getSupportRuntime } from "../../../src/server/runtime.ts";
import { json, localRequestError } from "../../../src/server/request.ts";
import { memoryScope, checkpointThreadId } from "../../../src/support-context.ts";
import { InformationError } from "../../../src/interactions/contracts.ts";
import { conversationSnapshot } from "../../../src/conversations/execution.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = localRequestError(request);
  if (rejected) return rejected;
  try {
    const thread = new URL(request.url).searchParams.get("thread") ?? "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(thread)) return json({ error: "会话标识无效。" }, 400);
    const { support, agent, information, conversation } = await getSupportRuntime();
    const scope = memoryScope(support);
    const savedThread = checkpointThreadId(thread, support);
    try {
      return json(await information.withThread(scope, savedThread,
        () => conversationSnapshot(agent, information, conversation, scope, savedThread, true)));
    } catch (cause) {
      if (!(cause instanceof InformationError && cause.message.includes("正在处理"))) throw cause;
      return json(await conversationSnapshot(agent, information, conversation, scope, savedThread, false));
    }
  } catch {
    return json({ code: "STATE_UNAVAILABLE", error: "无法恢复当前会话，请新建会话或核对服务状态。" }, 409);
  }
}
