import { AIMessage } from "langchain";
import type { createSupportAgent } from "./agent.ts";

// 接收同一个 Agent，便于用 fakeModel 验证观察逻辑，不依赖真实配置。
export async function observeAgent(
  agent: ReturnType<typeof createSupportAgent>,
  question: string,
  write: (line: string) => void = console.log,
): Promise<void> {
  const startedAt = performance.now();
  let finalAnswer = "";
  write("[开始] Agent 流式执行");

  try {
    // 一次 stream 执行同时订阅三类事件，不为观察而额外 invoke 一次模型。
    // messages：模型文本片段；updates：节点更新；values：用于读取最终状态。
    const stream = await agent.stream(
      { messages: [{ role: "user", content: question }] },
      { streamMode: ["messages", "updates", "values"] },
    );

    for await (const [mode, data] of stream) {
      if (mode === "messages") {
        const [message, metadata] = data;
        // 仅输出面向用户的文本，不打印 contentBlocks、reasoning 或完整 metadata。
        if (message.text) {
          write(`[文本片段][${metadata.langgraph_node ?? "model"}] ${JSON.stringify(message.text)}`);
        }
      } else if (mode === "updates") {
        // updates 是完成节点的状态差分，不代表节点开始；只输出节点名。
        for (const node of Object.keys(data)) {
          write(`[节点更新] ${node}`);
        }
      } else if (mode === "values") {
        // 消费快照但不打印完整 state，避免泄露历史、工具结果或其他内部数据。
        const lastMessage = data.messages.at(-1);
        finalAnswer = lastMessage && AIMessage.isInstance(lastMessage) ? lastMessage.text : "";
      }
    }

    // 只有流正常耗尽且存在最终回答，才报告成功；收到文本片段不等于成功。
    if (!finalAnswer.trim()) throw new Error("模型未返回有效文本回答。");
    write(`[最终回答] ${finalAnswer}`);
    write(`[完成] 耗时 ${Math.round(performance.now() - startedAt)} ms`);
  } catch (error: unknown) {
    write(`[失败] 本次执行未完成，已收到的片段不能作为完整结果；耗时 ${Math.round(performance.now() - startedAt)} ms`);
    throw error; // 交由入口设置非零退出码，测试也能验证错误传播。
  }
}
