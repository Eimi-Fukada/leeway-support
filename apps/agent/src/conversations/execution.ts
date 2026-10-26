import { createHash, randomUUID } from "node:crypto";
import type { createSupportAgent } from "../agent/agent.ts";
import type { SupportStateSnapshot } from "../agent/state.ts";
import type {
  InformationBackend,
  SupportRunResult,
} from "../interactions/service.ts";
import type { InformationSubmission } from "../interactions/contracts.ts";
import { validateAnswers } from "../interactions/contracts.ts";
import { informationPause } from "../interactions/pause.ts";
import {
  ConversationError,
  requestIdSchema,
  type ConversationSnapshot,
} from "./contracts.ts";
import { receiptSchema } from "./receipt.ts";
import type { ConversationBackend, RequestRecord } from "./service.ts";
import { redactPii } from "../agent/middleware/pii.ts";

type Agent = ReturnType<typeof createSupportAgent>;
export function requestHash(
  question: string,
  submission?: InformationSubmission,
) {
  const payload = submission
    ? {
        formId: submission.formId,
        interruptId: submission.interruptId,
        formVersion: submission.formVersion,
        cancelled: !!submission.cancelled,
        answers: Object.entries(submission.answers).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      }
    : { question };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// 调用方须已持有会话锁；这里只核对，不会 invoke/stream 或重新执行工具。
export async function reconcileRequest(
  agent: Agent,
  forms: InformationBackend,
  journal: ConversationBackend,
  scope: string,
  thread: string,
  record: RequestRecord,
) {
  if (!["running", "unknown"].includes(record.status)) return record;
  const state: SupportStateSnapshot = await agent.graph.getState({
    configurable: { thread_id: thread },
  });
  const receipt = receiptSchema.safeParse(
    state.values.supportCompletionReceipt,
  );
  if (
    !state.next.length &&
    !state.tasks.some((task) => task.error || task.interrupts?.length) &&
    receipt.success &&
    receipt.data.requestId === record.requestId &&
    receipt.data.runId === record.runId
  ) {
    const result: SupportRunResult = {
      status: "completed",
      answer: receipt.data.answer,
      runId: receipt.data.runId,
      elapsedMs: 0,
      reconciled: true,
    };
    await forms.confirm(scope, thread, record.requestId, result);
    await journal.finish(scope, thread, record.requestId, result);
  } else {
    let pause;
    try {
      pause = informationPause(state);
    } catch {
      /* 失败与未知分别记账，绝不自动重跑。 */
    }
    // 恢复请求继承原逻辑 runId；旧暂停点不能证明本次 resume 已经执行。
    if (record.kind === "message" && pause && pause.runId === record.runId) {
      const information = await forms.wait(
        scope,
        thread,
        pause.runId,
        pause.formId,
        pause.id,
      );
      await journal.finish(scope, thread, record.requestId, {
        status: "waiting_for_input",
        answer: "",
        runId: pause.runId,
        elapsedMs: 0,
        reconciled: true,
        information,
      });
    } else
      await journal.uncertain(
        scope,
        thread,
        record.requestId,
        state.tasks.some((task) => task.error) ? "failed" : "unknown",
      );
  }
  return (await journal.find(scope, thread, record.requestId))!;
}

export async function executeRecorded(options: {
  agent: Agent;
  forms: InformationBackend;
  journal: ConversationBackend;
  scope: string;
  thread: string;
  requestId: string;
  payloadHash: string;
  question: string;
  submission?: InformationSubmission;
  work: (requestId: string, runId: string) => Promise<SupportRunResult>;
}) {
  const {
    agent,
    forms,
    journal,
    scope,
    thread,
    requestId,
    payloadHash,
    submission,
  } = options;
  requestIdSchema.parse(requestId);
  let existing = await journal.find(scope, thread, requestId);
  if (existing) {
    if (existing.payloadHash !== payloadHash)
      throw new ConversationError("同一请求 ID 对应了不同内容，拒绝再次执行。");
    existing = await reconcileRequest(
      agent,
      forms,
      journal,
      scope,
      thread,
      existing,
    );
    if (
      existing.result &&
      ["completed", "waiting_for_input"].includes(existing.status)
    ) {
      if (submission && existing.status === "completed")
        await forms.confirm(scope, thread, requestId, existing.result);
      if (
        existing.status === "waiting_for_input" &&
        existing.result.information
      ) {
        const currentForm = await forms.get(
          scope,
          thread,
          existing.result.information.formId,
        );
        if (currentForm.status === "submitted")
          throw new ConversationError(
            "原请求的等待已由后续提交处理，请读取当前会话记录，不再发布旧暂停点。",
          );
        return { ...existing.result, information: currentForm };
      }
      return existing.result;
    }
    throw new ConversationError(
      existing.status === "failed"
        ? "原请求执行失败，不会以相同 ID 自动重跑，请查看状态。"
        : "原请求结果未知，不能确认可安全重试；请核对状态或新建会话。",
    );
  }
  const history = await journal.history(scope, thread);
  if (
    history.requests.some((record) =>
      ["running", "unknown", "failed"].includes(record.status),
    )
  ) {
    throw new ConversationError(
      "会话有未确认或失败请求，请先查询状态；不会启动下一次执行。",
    );
  }
  const state: SupportStateSnapshot = await agent.graph.getState({
    configurable: { thread_id: thread },
  });
  const pause = informationPause(state);
  let content = redactPii(options.question);
  let runId: string = randomUUID();
  if (submission) {
    if (
      !pause ||
      pause.id !== submission.interruptId ||
      pause.formId !== submission.formId
    )
      throw new ConversationError("没有与提交匹配的等待流程。");
    const form = await forms.get(scope, thread, pause.formId);
    if (form.status !== "pending" || Date.parse(form.expiresAt) <= Date.now())
      throw new ConversationError("表单已失效，不能接收本次请求。");
    if (submission.cancelled && Object.keys(submission.answers).length)
      throw new ConversationError("取消请求不能携带答案。");
    const answers = submission.cancelled
      ? {}
      : validateAnswers(form.spec, submission.answers);
    content = submission.cancelled
      ? "取消补充信息。"
      : `提交补充资料：\n${form.spec.fields
          .map((field) => {
            const answer =
              field.type === "select"
                ? (field.options.find(
                    (entry) => entry.value === answers[field.key],
                  )?.label ?? "未填写")
                : (answers[field.key] ?? "未填写");
            return `- ${redactPii(field.label)}：${redactPii(answer)}`;
          })
          .join("\n")}`;
    runId = pause.runId;
  } else if (pause)
    throw new ConversationError(
      "当前流程等待补充资料，请填写或取消，不会启动新一轮。",
    );
  const historyComplete =
    history.historyComplete &&
    (history.messages.length > 0 || !state.values.messages?.length);
  await journal.start(
    scope,
    thread,
    requestId,
    runId,
    payloadHash,
    content,
    historyComplete,
    submission ? "resume" : "message",
  );
  try {
    const result = await options.work(requestId, runId);
    await journal.finish(scope, thread, requestId, result);
    return result;
  } catch (error) {
    // 回执可能已经落 checkpoint 但档案未落库；核对成功仅修复记录，不再请求模型。
    try {
      await reconcileRequest(
        agent,
        forms,
        journal,
        scope,
        thread,
        (await journal.find(scope, thread, requestId))!,
      );
    } catch {
      await journal
        .uncertain(scope, thread, requestId, "unknown")
        .catch(() => {});
    }
    throw error;
  }
}

export async function conversationSnapshot(
  agent: Agent,
  forms: InformationBackend,
  journal: ConversationBackend,
  scope: string,
  thread: string,
  locked: boolean,
): Promise<ConversationSnapshot> {
  let history = await journal.history(scope, thread);
  if (locked) {
    for (const entry of history.requests.filter((entry) =>
      ["running", "unknown"].includes(entry.status),
    )) {
      const record = await journal.find(scope, thread, entry.requestId);
      if (record)
        await reconcileRequest(agent, forms, journal, scope, thread, record);
    }
    history = await journal.history(scope, thread);
  }
  const state: SupportStateSnapshot = await agent.graph.getState({
    configurable: { thread_id: thread },
  });
  let information;
  let pause;
  try {
    pause = informationPause(state);
  } catch {
    /* 失败/未知状态从持久请求与 checkpoint 确认，不猜造完成。 */
  }
  if (pause) {
    try {
      information = locked
        ? await forms.wait(scope, thread, pause.runId, pause.formId, pause.id)
        : await forms.get(scope, thread, pause.formId);
    } catch {
      throw new ConversationError(
        "等待表单读取失败，请稍后核对；不会自动重跑或允许普通消息绕过暂停。",
      );
    }
  }
  const last = history.requests.at(-1);
  const hasState = !!state.values.messages?.length;
  const status: ConversationSnapshot["status"] = !locked
    ? "running"
    : (last?.status ??
      (information ? "waiting_for_input" : hasState ? "unknown" : "empty"));
  const historyComplete =
    history.historyComplete && (!hasState || history.messages.length > 0);
  return {
    ...history,
    status,
    historyComplete,
    ...(information ? { information } : {}),
    ...(!historyComplete
      ? {
          notice:
            "该旧会话没有完整的独立消息档案，只展示已归档部分；原 checkpoint 未被改写。",
        }
      : status === "unknown"
        ? { notice: "执行结果尚未确认；不会自动重跑模型或工具。请核对原请求。" }
        : status === "failed"
          ? { notice: "本次执行失败，部分操作可能已提交，不会自动重跑。" }
          : {}),
  };
}
