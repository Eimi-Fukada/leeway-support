import { applyStrategy, createMiddleware, resolveRedactionRule } from "langchain";
import { mapStoredMessagesToChatMessages } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

// 规则是有范围的检测，不是所有个人信息的识别器；不保留可还原的原文映射。
const rules = [
  resolveRedactionRule({ piiType: "email", strategy: "redact" }),
  resolveRedactionRule({ piiType: "credit_card", strategy: "redact" }),
  resolveRedactionRule({
    piiType: "cn_phone", strategy: "redact",
    detector: /(?<![\dA-Za-z])(?:\+?86[- ]?)?1[3-9]\d{9}(?![\dA-Za-z])/g,
  }),
];

export function redactPii(text: string): string {
  for (const rule of rules) {
    text = applyStrategy(text, rule.detector(text), rule.strategy, rule.piiType);
  }
  return text;
}

// 保留消息 ID、角色及工具配对信息；只处理当前应用支持的文本消息。
export function redactMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (typeof message.content !== "string") return message;
    const content = redactPii(message.content);
    if (content === message.content) return message;
    const stored = message.toDict();
    return mapStoredMessagesToChatMessages([{ ...stored, data: { ...stored.data, content } }])[0]!;
  });
}

export function createPiiMiddleware() {
  return createMiddleware({
    name: "SupportInputPII",
    beforeModel: (state) => {
      const messages = redactMessages(state.messages);
      const changed = messages.filter((message, index) => message !== state.messages[index]);
      return changed.length ? { messages: changed } : undefined;
    },
  });
}
