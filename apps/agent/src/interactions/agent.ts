import {
  createMiddleware,
  tool,
  ToolMessage,
  type ToolRuntime,
} from "langchain";
import { z } from "zod";
import { interrupt, isGraphInterrupt } from "@langchain/langgraph";
import {
  informationSpecSchema,
  informationReplySchema,
  InformationError,
  validateAnswers,
} from "./contracts.ts";
import { redactPii } from "../agent/middleware/pii.ts";
import type { InformationBackend } from "./service.ts";
import { memoryScope, validateSupportContext } from "../support-context.ts";
import type { SupportContext } from "../support-context.ts";

export const interactionContextSchema = z.object({ runId: z.uuid() });

export function informationTool(service: InformationBackend) {
  return tool(
    async (
      spec,
      runtime: ToolRuntime<
        unknown,
        { support?: SupportContext; interaction?: { runId: string } }
      >,
    ) => {
      const support = validateSupportContext(runtime.context.support);
      const { runId } = interactionContextSchema.parse(
        runtime.context.interaction,
      );
      const threadId = runtime.config.configurable?.thread_id;
      if (typeof threadId !== "string" || !runtime.toolCallId)
        throw new InformationError("缺少会话执行上下文。");
      const form = await service.create(
        memoryScope(support),
        threadId,
        runId,
        runtime.toolCallId,
        spec,
      );
      // 节点恢复会重进：create 以原 run/toolCall 幂等，不改变已发布的表单。
      // 不捕获 interrupt 的内部控制信号；它会保存 checkpoint 并结束本次网络执行。
      const reply = informationReplySchema.parse(
        interrupt({ kind: "information", formId: form.formId, runId }),
      );
      if (reply.formId !== form.formId)
        throw new InformationError("恢复内容与当前表单不匹配。");
      const answers = reply.cancelled
        ? {}
        : validateAnswers(form.spec, reply.answers);
      const entries = reply.cancelled
        ? []
        : form.spec.fields.map((field) => ({
            question: field.label,
            answer: redactPii(
              field.type === "select"
                ? (field.options.find(
                    (entry) => entry.value === answers[field.key],
                  )?.label ?? "未填写")
                : (answers[field.key] ?? ""),
            ),
          }));
      return {
        status: reply.cancelled ? "cancelled" : "answered",
        formId: form.formId,
        submissionId: reply.submissionId,
        // 后续模型看到答案标签而非仅看到枚举 value；这是用户数据，不是系统指令。
        entries,
        source: {
          messageId: reply.submissionId,
          text: redactPii(JSON.stringify({ answers, entries })),
        },
      };
    },
    {
      name: "request_information",
      description:
        "确实缺少诊断所需信息时，创建表单并暂停执行，等用户填写或取消后返回结果。普通问答直接回答。一个逻辑任务最多一份；不得与其他工具并行调用。控件和选项按问题选择，不编造权限，不索要密码、验证码或密钥。取消时尊重用户选择，不再重复要求填写。",
      schema: informationSpecSchema,
    },
  );
}

export function informationMiddleware() {
  return createMiddleware({
    name: "SupportInformationRequest",
    afterModel: (state) => {
      const last = state.messages.at(-1);
      if (
        last &&
        "tool_calls" in last &&
        Array.isArray(last.tool_calls) &&
        last.tool_calls.some((call) => call.name === "request_information") &&
        last.tool_calls.length > 1
      ) {
        throw new InformationError(
          "补资料请求必须单独调用，不能与其他工具并行。",
        );
      }
    },
    wrapToolCall: async (request, handler) => {
      let result;
      try {
        result = await handler(request);
      } catch (cause) {
        if (
          isGraphInterrupt(cause) ||
          cause instanceof InformationError ||
          request.toolCall.name !== "request_information"
        )
          throw cause;
        throw new InformationError(
          "资料工具执行失败，本次执行未完成；不会自动重试。",
          { cause },
        );
      }
      if (
        request.toolCall.name === "request_information" &&
        ToolMessage.isInstance(result) &&
        result.status === "error"
      )
        throw new InformationError(
          "未能创建有效表单，本轮停止；不会自动重试。",
        );
      return result;
    },
  });
}
