import type { createSupportAgent } from "./agent.ts";
import { runSupportAgent } from "./run.ts";

// write 接收原始文本片段（不自动加换行），便于终端展示与离线验证共用此入口。
export async function runSupportCli(
  agent: ReturnType<typeof createSupportAgent>,
  question: string,
  write: (text: string) => void = (text) => { process.stdout.write(text); },
  debug = false,
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
    });
    if (debug) write(`[最终回答] ${result.answer}\n`);
    else write("\n");
    write(`[完成] 耗时 ${result.elapsedMs} ms\n`);
    return result;
  } catch (error: unknown) {
    if (!debug) write("\n");
    write("[失败] 本次执行未完成，已收到的片段不能作为完整结果。\n");
    throw error;
  }
}
