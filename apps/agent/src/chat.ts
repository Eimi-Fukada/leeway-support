import { randomUUID } from "node:crypto";
import type { createSupportAgent } from "./agent.ts";
import { runSupportCli } from "./cli-run.ts";

// 输入循环只管理终端会话，不自行拼接历史；每一轮 await 完成后才消费下一行。
export async function chat(
  agent: ReturnType<typeof createSupportAgent>,
  lines: AsyncIterable<string> | (() => AsyncIterable<string>),
  write: (text: string) => void = (text) => { process.stdout.write(text); },
  debug = false,
  resumeThreadId?: string,
): Promise<void> {
  let threadId = resumeThreadId ?? randomUUID();
  if (resumeThreadId !== undefined) {
    // 查看状态不会请求模型；仅允许继续已完成的会话，不自动重跑失败步骤。
    const state = await agent.graph.getState({ configurable: { thread_id: resumeThreadId } });
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
      await runSupportCli(agent, question, write, debug, threadId);
    }
    write("你> ");
  }
  write("\n[会话结束]\n");
}
