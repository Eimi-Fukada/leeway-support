import { randomUUID } from "node:crypto";
import type { createSupportAgent } from "./agent.ts";
import { runSupportCli } from "./cli-run.ts";

// 输入循环只管理终端会话，不自行拼接历史；每一轮 await 完成后才消费下一行。
export async function chat(
  agent: ReturnType<typeof createSupportAgent>,
  lines: AsyncIterable<string>,
  write: (text: string) => void = (text) => { process.stdout.write(text); },
  debug = false,
): Promise<void> {
  let threadId = randomUUID();
  write("输入问题开始对话；/new 新会话，/exit 退出。记忆仅保存在本进程，退出或开发模式重启后丢失。\n");
  write(`[会话] ${threadId}\n你> `);

  for await (const line of lines) {
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
