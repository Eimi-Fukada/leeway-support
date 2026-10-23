import { randomUUID } from "node:crypto";
import type { createSupportAgent } from "../agent/agent.ts";
import { runSupportAgent } from "../agent/run.ts";
import { checkpointThreadId, type SupportContext } from "../support-context.ts";

// 本文件按“启动参数 → 会话循环 → 单轮展示”组织，终端交互只需在这里阅读。
export function parseCliOptions(args: string[]): { debug: boolean; threadId?: string; userId?: string } {
  let debug = false;
  let threadId: string | undefined;
  let userId: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue; // 兼容 pnpm start -- --thread <id>。
    if (arg === "--debug") debug = true;
    else if (arg === "--user" && userId === undefined) {
      const value = args[++index];
      if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("启动参数无效：--user 需要有效的本地开发用户 ID。");
      userId = value;
    }
    else if (arg === "--thread" && threadId === undefined) {
      const value = args[++index];
      if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
        throw new Error("启动参数无效：--thread 需要一个有效的会话 ID。");
      }
      threadId = value;
    } else {
      throw new Error("启动参数无效：支持 --user <开发用户ID>、--debug 和 --thread <会话ID>。");
    }
  }
  return { debug, threadId, ...(userId === undefined ? {} : { userId }) };
}

// 输入循环只管理终端会话，不自行拼接历史；每一轮 await 完成后才消费下一行。
export async function chat(
  agent: ReturnType<typeof createSupportAgent>,
  lines: AsyncIterable<string> | (() => AsyncIterable<string>),
  write: (text: string) => void = (text) => { process.stdout.write(text); },
  debug = false,
  resumeThreadId?: string,
  context?: SupportContext,
): Promise<void> {
  let threadId = resumeThreadId ?? randomUUID();
  if (resumeThreadId !== undefined) {
    // 查看状态不会请求模型；仅允许继续已完成的会话，不自动重跑失败步骤。
    const state = await agent.graph.getState({ configurable: { thread_id: checkpointThreadId(resumeThreadId, context) } });
    if (!state.values.messages?.length) throw new Error("会话恢复失败：未找到已保存的会话。");
    if (state.next.length > 0 || state.tasks?.some((task) => task.error || task.interrupts?.length)) {
      throw new Error("会话恢复失败：存在未完成步骤，本轮不自动重试，请使用新会话。");
    }
    write("[已恢复会话] 后续问题将使用已保存的历史。\n");
  }
  write("输入问题开始对话；/new 新会话，/exit 退出。历史由 checkpointer 保存；恢复时使用原会话 ID。\n");
  write(`[会话] ${threadId}\n你> `);

  // 恢复校验需要异步读库；真实 readline 延迟创建，避免校验时提前消费 stdin。
  const inputLines = typeof lines === "function" ? lines() : lines;
  for await (const line of inputLines) {
    const question = line.trim();
    if (question === "/exit") break;
    if (question === "/new") {
      threadId = randomUUID();
      write(`[新会话] ${threadId}\n`);
    } else if (question.startsWith("/")) {
      write("[提示] 支持 /new 和 /exit；未知命令不会提交给模型。\n");
    } else if (question) {
      // 失败向上传播并终止输入循环，不自动提交下一行或重试失败轮次。
      await runSupportCli(agent, question, write, debug, threadId, context);
    }
    write("你> ");
  }
  write("\n[会话结束]\n");
}

// write 接收原始文本片段（不自动加换行），便于终端展示与离线验证共用。
export async function runSupportCli(
  agent: ReturnType<typeof createSupportAgent>,
  question: string,
  write: (text: string) => void = (text) => { process.stdout.write(text); },
  debug = false,
  threadId?: string,
  context?: SupportContext,
) {
  write(debug ? "[开始] Agent 流式执行\n" : "[客服] ");
  try {
    const result = await runSupportAgent(agent, question, (event) => {
      if (event.type === "text") {
        write(debug ? `[文本片段][${event.node}] ${JSON.stringify(event.text)}\n` : event.text);
      } else if (debug) {
        // 节点更新不是节点开始，也不是网络请求次数。
        write(`[节点更新] ${event.node}\n`);
      }
    }, threadId, context);
    if (debug) {
      write(`[追踪ID] ${result.runId}\n`);
      write(`[最终回答] ${result.answer}\n`);
    }
    else write("\n");
    write(`[完成] 耗时 ${result.elapsedMs} ms\n`);
    return result;
  } catch (error: unknown) {
    if (!debug) write("\n");
    write("[失败] 本次执行未完成，已收到的片段不能作为完整结果。\n");
    throw error;
  }
}
