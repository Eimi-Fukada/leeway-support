import { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { createSupportAgent } from "../agent/agent.ts";
import { runSupportAgent } from "../agent/run.ts";
import { InformationError, submissionSchema } from "../interactions/contracts.ts";
import type { InformationBackend } from "../interactions/service.ts";
import type { SupportContext } from "../support-context.ts";

const forwardedSchema = z.object({ informationSubmission: submissionSchema.optional() }).passthrough();

// 适配的是已有执行入口，不采纳客户端传来的历史、system、tools、state 或身份。
// CopilotKit 使用 AG-UI 观察当前轮；历史事实仍由服务端 checkpoint 提供。
export class SupportUiAgent extends AbstractAgent {
  constructor(private readonly supportAgent: ReturnType<typeof createSupportAgent>,
    private readonly information: InformationBackend, private readonly support: SupportContext) {
    super({ agentId: "support", description: "Leeway Support 客服" });
  }

  clone() { return new SupportUiAgent(this.supportAgent, this.information, this.support); }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const abort = new AbortController();
      const emit = (event: BaseEvent) => { if (!subscriber.closed) subscriber.next(event); };
      const assistantId = randomUUID();
      let textStarted = false;
      void (async () => {
        try {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.threadId)) throw new InformationError("会话标识无效。");
          const forwarded = forwardedSchema.safeParse(input.forwardedProps ?? {});
          if (!forwarded.success) throw new InformationError("提交内容格式无效。");
          const latest = input.messages.at(-1);
          if (!latest || latest.role !== "user" || typeof latest.content !== "string" || !latest.content.trim() || latest.content.length > 12_000)
            throw new InformationError("请提交有效的问题。");
          emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
          const result = await runSupportAgent(this.supportAgent, latest.content, (event) => {
            if (event.type !== "text") return;
            if (!textStarted) { emit({ type: EventType.TEXT_MESSAGE_START, messageId: assistantId, role: "assistant" }); textStarted = true; }
            emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: assistantId, delta: event.text });
          }, input.threadId, this.support, { service: this.information,
            submission: forwarded.data.informationSubmission, signal: abort.signal });
          if (!textStarted) {
            // 同一已完成提交的重放直接返回持久结果，不再调用模型。
            emit({ type: EventType.TEXT_MESSAGE_START, messageId: assistantId, role: "assistant" });
            emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: assistantId, delta: result.answer });
          }
          emit({ type: EventType.TEXT_MESSAGE_END, messageId: assistantId });
          if (result.information) {
            // 只有同一轮正常完成后才发布可填写表单；不泄露其他内部工具/状态。
            const callId = result.information.formId;
            emit({ type: EventType.TOOL_CALL_START, toolCallId: callId, toolCallName: "request_information", parentMessageId: assistantId });
            emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: JSON.stringify(result.information.spec) });
            emit({ type: EventType.TOOL_CALL_END, toolCallId: callId });
            emit({ type: EventType.TOOL_CALL_RESULT, toolCallId: callId, messageId: randomUUID(), role: "tool", content: JSON.stringify(result.information) });
          }
          emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
        } catch (cause) {
          if (textStarted) emit({ type: EventType.TEXT_MESSAGE_END, messageId: assistantId });
          emit({ type: EventType.RUN_ERROR, message: cause instanceof InformationError ? cause.message
            : "本轮未完成；已收到的片段不能作为完整结果。请检查服务，失败执行不会自动重试。", code: "SUPPORT_RUN_FAILED" });
        } finally { subscriber.complete(); }
      })();
      // 断开观察会取消本轮模型请求；已提交的记忆操作不会回滚。
      return () => abort.abort();
    });
  }
}
