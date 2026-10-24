import { createMiddleware, tool, ToolMessage, type ToolRuntime } from "langchain";
import { z } from "zod";
import { informationSpecSchema, InformationError } from "./contracts.ts";
import type { InformationBackend } from "./service.ts";
import { memoryScope, validateSupportContext } from "../support-context.ts";
import type { SupportContext } from "../support-context.ts";

export const interactionContextSchema = z.object({ runId: z.uuid() });

export function informationTool(service: InformationBackend) {
  return tool(async (spec, runtime: ToolRuntime<unknown, { support?: SupportContext; interaction?: { runId: string } }>) => {
    const support = validateSupportContext(runtime.context.support);
    const { runId } = interactionContextSchema.parse(runtime.context.interaction);
    const threadId = runtime.config.configurable?.thread_id;
    if (typeof threadId !== "string" || !runtime.toolCallId) throw new InformationError("缺少会话执行上下文。");
    const form = await service.create(memoryScope(support), threadId, runId, runtime.toolCallId, spec);
    return { status: "created", form };
  }, {
    name: "request_information",
    description: "确实缺少诊断所需信息时，创建一份补充信息表单。普通问答直接回答，不必创建表单。一轮最多一份；控件和选项按问题选择，不编造产品支持范围、用户任务或权限。不得索要密码、验证码、密钥或完整敏感个人信息。创建成功只代表提出问题，不能声称用户已经提交或问题已解决。",
    schema: informationSpecSchema,
  });
}

export function informationMiddleware() {
  return createMiddleware({
    name: "SupportInformationRequest",
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      if (request.toolCall.name === "request_information" && ToolMessage.isInstance(result) && result.status === "error")
        throw new InformationError("未能创建有效表单，本轮停止；不会自动重试。");
      return result;
    },
  });
}
