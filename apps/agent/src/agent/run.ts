import { AIMessage, HumanMessage } from "langchain";
import { Command } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import type { createSupportAgent } from "./agent.ts";
import { redactPii } from "./middleware/pii.ts";
import {
  markModelOutput,
  withRetryProgress,
} from "./middleware/model-retry.ts";
import {
  checkpointThreadId,
  memoryScope,
  validateSupportContext,
  type SupportContext,
} from "../support-context.ts";
import type {
  InformationBackend,
  SupportRunResult,
} from "../interactions/service.ts";
import {
  InformationError,
  type InformationSubmission,
} from "../interactions/contracts.ts";
import { informationPause } from "../interactions/pause.ts";
import type { ConversationBackend } from "../conversations/service.ts";
import { executeRecorded, requestHash } from "../conversations/execution.ts";

export type SupportRunEvent =
  | { type: "text"; text: string; node: string }
  | { type: "node-update"; node: string };

export async function runSupportAgent(
  agent: ReturnType<typeof createSupportAgent>,
  question: string,
  onEvent: (event: SupportRunEvent) => void = () => {},
  threadId?: string,
  context?: SupportContext,
  interaction?: {
    service: InformationBackend;
    submission?: InformationSubmission;
    signal?: AbortSignal;
    restore?: boolean;
    conversation?: ConversationBackend;
    requestId?: string;
  },
): Promise<SupportRunResult> {
  if (!question.trim() && !interaction?.restore && !interaction?.submission)
    throw new Error("用户输入不能为空。");
  if (threadId !== undefined && !threadId.trim())
    throw new Error("会话标识不能为空。");
  const payloadHash = requestHash(question, interaction?.submission);
  question = redactPii(question);
  const support =
    context === undefined ? undefined : validateSupportContext(context);
  let recorded: { requestId: string; runId: string } | undefined;
  const execute = async (): Promise<SupportRunResult> => {
    const scope = interaction
      ? memoryScope(validateSupportContext(support))
      : "";
    const savedThread = threadId ? checkpointThreadId(threadId, support) : "";
    let logicalRunId: string = recorded?.runId ?? randomUUID();
    let graphInput: { messages: HumanMessage[] } | Command = {
      messages: [new HumanMessage({ id: recorded?.requestId ?? randomUUID(), content: question })],
    };
    if (interaction) {
      if (!savedThread) throw new InformationError("需要明确的会话标识。");
      if (interaction.signal?.aborted)
        throw new InformationError("本轮已取消。");
      // 重复已完成提交只读取持久结果，即使后续会话状态改变也不再次恢复 Graph。
      if (interaction.submission) {
        const replay = await interaction.service.replay(
          scope,
          savedThread,
          interaction.submission,
        );
        if (replay) return replay;
      }
      const previous = await agent.graph.getState({
        configurable: { thread_id: savedThread },
      });
      const pause = informationPause(previous);
      if (interaction.restore) {
        const form = pause
          ? await interaction.service.wait(
              scope,
              savedThread,
              pause.runId,
              pause.formId,
              pause.id,
            )
          : undefined;
        return {
          status: form ? "waiting_for_input" : "completed",
          answer: "",
          elapsedMs: 0,
          runId: pause?.runId ?? logicalRunId,
          ...(form ? { information: form } : {}),
        };
      }
      if (pause) {
        const form = await interaction.service.wait(
          scope,
          savedThread,
          pause.runId,
          pause.formId,
          pause.id,
        );
        if (!interaction.submission)
          throw new InformationError(
            "当前流程正在等待表单，请填写或取消；不会启动新一轮。",
          );
        if (
          form.formId !== interaction.submission.formId ||
          pause.id !== interaction.submission.interruptId
        ) {
          throw new InformationError("提交与当前暂停点不匹配，请刷新表单。");
        }
        const accepted = await interaction.service.accept(
          scope,
          savedThread,
          interaction.submission,
        );
        if ("replay" in accepted) return accepted.replay;
        logicalRunId = pause.runId;
        graphInput = new Command({ resume: { [pause.id]: accepted.resume } });
      } else {
        if (interaction.submission)
          throw new InformationError("当前会话没有匹配的待恢复表单。");
        await interaction.service.begin(scope, savedThread);
      }
    }
    return withRetryProgress(async () => {
      const startedAt = performance.now();
      const traceRunId = randomUUID();
      let answer = "";
      try {
        const stream = await agent
          .withConfig({
            runId: traceRunId,
            runName: "support-turn",
            tags: ["leeway-support"],
            callbacks: [
              {
                name: "support-stream-progress",
                handleLLMNewToken: () => {
                  markModelOutput();
                },
              },
            ],
            metadata: {
              logical_run_id: logicalRunId,
              ...(threadId ? { thread_id: threadId } : {}),
            },
          })
          .stream(graphInput, {
            streamMode: ["messages", "updates", "values"],
            signal: interaction?.signal
              ? AbortSignal.any([
                  interaction.signal,
                  AbortSignal.timeout(65_000),
                ])
              : AbortSignal.timeout(65_000),
            context: {
              ...(support ? { support } : {}),
              ...(interaction ? { interaction: { runId: logicalRunId, ...(recorded ? { requestId: recorded.requestId } : {}) } } : {}),
            },
            ...(threadId === undefined
              ? {}
              : { configurable: { thread_id: savedThread } }),
          });
        for await (const [mode, data] of stream) {
          if (mode === "messages") {
            const [message, metadata] = data;
            if (
              message.type !== "ai" ||
              metadata.lc_source === "summarization" ||
              metadata.tags?.includes("nostream")
            )
              continue;
            if (message.text)
              onEvent({
                type: "text",
                text: message.text,
                node: metadata.langgraph_node ?? "model",
              });
          } else if (mode === "updates") {
            for (const node of Object.keys(data))
              onEvent({ type: "node-update", node });
          } else if (mode === "values") {
            // 暂停会产生只含 __interrupt__ 的 values 帧，不是完整 messages 快照。
            const last = data.messages?.at(-1);
            answer =
              last && AIMessage.isInstance(last) && !last.tool_calls?.length
                ? last.text
                : "";
          }
        }
        if (interaction?.signal?.aborted)
          throw new InformationError("本次执行已取消，请重新核对会话状态。");
        if (interaction) {
          const state = await agent.graph.getState({
            configurable: { thread_id: savedThread },
          });
          const pause = informationPause(state);
          if (pause) {
            const information = await interaction.service.wait(
              scope,
              savedThread,
              pause.runId,
              pause.formId,
              pause.id,
            );
            return {
              status: "waiting_for_input",
              answer: "",
              elapsedMs: Math.round(performance.now() - startedAt),
              runId: logicalRunId,
              information,
            };
          }
        }
        if (!answer.trim()) throw new Error("模型未返回有效文本回答。");
        const result: SupportRunResult = {
          status: "completed",
          answer,
          elapsedMs: Math.round(performance.now() - startedAt),
          runId: interaction ? logicalRunId : traceRunId,
        };
        if (interaction?.submission)
          await interaction.service.record(
            scope,
            savedThread,
            interaction.submission,
            result,
          );
        return result;
      } catch (error) {
        // 等待/失联不等同失败：checkpoint 里已有合法暂停点时保留表单，供显式恢复。
        if (interaction) {
          try {
            const state = await agent.graph.getState({
              configurable: { thread_id: savedThread },
            });
            if (!informationPause(state))
              await interaction.service.finish(
                scope,
                savedThread,
                logicalRunId,
                false,
              );
          } catch {
            await interaction.service
              .finish(scope, savedThread, logicalRunId, false)
              .catch(() => {});
          }
        }
        throw error;
      }
    });
  };
  const work = async () => {
    if (!interaction?.conversation || interaction.restore) return execute();
    if (!threadId || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) throw new Error("会话记录：需要有效的会话标识。");
    const requestId = interaction.submission?.submissionId ?? interaction.requestId;
    if (!requestId) throw new Error("会话记录：需要稳定的请求 ID。");
    return executeRecorded({ agent, forms: interaction.service, journal: interaction.conversation,
      scope: memoryScope(validateSupportContext(support)), thread: checkpointThreadId(threadId ?? "", support),
      requestId, payloadHash, question, submission: interaction.submission,
      work: async (id, runId) => { recorded = { requestId: id, runId }; return execute(); } });
  };
  return interaction
    ? interaction.service.withThread(
        memoryScope(validateSupportContext(support)),
        checkpointThreadId(threadId ?? "", support),
        work,
      )
    : work();
}
