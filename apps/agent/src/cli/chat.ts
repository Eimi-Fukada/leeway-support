import { randomUUID } from "node:crypto";
import type { createSupportAgent } from "../agent/agent.ts";
import { runSupportAgent } from "../agent/run.ts";
import { checkpointThreadId, type SupportContext } from "../support-context.ts";
import type { InformationBackend } from "../interactions/service.ts";
import { informationPause } from "../interactions/pause.ts";
import { InformationError, type InformationForm, type InformationSubmission } from "../interactions/contracts.ts";

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
  information?: InformationBackend,
): Promise<void> {
  let threadId = resumeThreadId ?? randomUUID();
  let pending: InformationForm | undefined;
  if (resumeThreadId !== undefined) {
    // 查看状态不会请求模型；仅允许继续已完成的会话，不自动重跑失败步骤。
    const state = await agent.graph.getState({ configurable: { thread_id: checkpointThreadId(resumeThreadId, context) } });
    if (!state.values.messages?.length) throw new Error("会话恢复失败：未找到已保存的会话。");
    const pause = information ? informationPause(state) : undefined;
    if (!pause && (state.next.length > 0 || state.tasks?.some((task) => task.error || task.interrupts?.length))) {
      throw new Error("会话恢复失败：存在未完成步骤，本轮不自动重试，请使用新会话。");
    }
    write("[已恢复会话] 后续问题将使用已保存的历史。\n");
    if (pause && information) {
      pending = (await runSupportAgent(agent, "", undefined, threadId, context, { service: information, restore: true })).information;
    }
  }
  write("输入问题开始对话；/new 新会话，/exit 退出。历史由 checkpointer 保存；恢复时使用原会话 ID。\n");
  write(`[会话] ${threadId}\n你> `);
  if (pending) printInformation(pending, write);

  // 恢复校验需要异步读库；真实 readline 延迟创建，避免校验时提前消费 stdin。
  const inputLines = typeof lines === "function" ? lines() : lines;
  for await (const line of inputLines) {
    const question = line.trim();
    if (question === "/exit") break;
    if (question === "/new") {
      threadId = randomUUID();
      pending = undefined;
      write(`[新会话] ${threadId}\n`);
    } else if (pending && (question === "/cancel" || question.startsWith("/submit "))) {
      try {
        const answers = question === "/cancel" ? {} : JSON.parse(question.slice(8));
        const submission = { formId: pending.formId, formVersion: pending.formVersion, interruptId: pending.interruptId!,
          submissionId: randomUUID(), cancelled: question === "/cancel", answers };
        pending = (await runSupportCli(agent, "", write, debug, threadId, context, information, submission)).information;
      } catch (error) {
        if (error instanceof SyntaxError) write('[提示] 请使用 /submit {"字段key":"答案"} 提交 JSON。\n');
        else throw error;
      }
    } else if (question.startsWith("/")) {
      write("[提示] 支持 /new 和 /exit；未知命令不会提交给模型。\n");
    } else if (question) {
      // 失败向上传播并终止输入循环，不自动提交下一行或重试失败轮次。
      if (pending) write("[等待] 请使用 /submit 提交表单答案或 /cancel 取消；不会启动新一轮。\n");
      else pending = (await runSupportCli(agent, question, write, debug, threadId, context, information)).information;
    }
    write("你> ");
  }
  write("\n[会话结束]\n");
}

function printInformation(form: InformationForm, write: (text: string) => void) {
  write(`[等待补充] ${form.spec.title}\n${form.spec.description}\n`);
  for (const field of form.spec.fields) write(`- ${field.key}: ${field.label}${field.required ? "（必填）" : ""}${field.type === "select" ? `：${field.options.map((entry) => `${entry.value}=${entry.label}`).join(" / ")}` : ""}\n`);
  write('使用 /submit {"字段key":"答案"} 提交，或 /cancel 取消；也可在同一会话页面填写。\n');
}

// write 接收原始文本片段（不自动加换行），便于终端展示与离线验证共用。
export async function runSupportCli(
  agent: ReturnType<typeof createSupportAgent>,
  question: string,
  write: (text: string) => void = (text) => { process.stdout.write(text); },
  debug = false,
  threadId?: string,
  context?: SupportContext,
  information?: InformationBackend,
  submission?: InformationSubmission,
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
    }, threadId, context, information ? { service: information, submission } : undefined);
    if (debug) {
      write(`[追踪ID] ${result.runId}\n`);
      if (result.status !== "waiting_for_input") write(`[最终回答] ${result.answer}\n`);
    }
    else write("\n");
    if (result.information) {
      printInformation(result.information, write);
    }
    if (result.status !== "waiting_for_input") write(`[完成] 耗时 ${result.elapsedMs} ms\n`);
    return result;
  } catch (error: unknown) {
    if (!debug) write("\n");
    write("[失败] 本次执行未完成，已收到的片段不能作为完整结果。\n");
    throw error;
  }
}
