import type { BaseMessage } from "@langchain/core/messages";
import type { StateSnapshot } from "@langchain/langgraph";

// 应用只读取这些 checkpoint 字段；tasks 沿用 SDK 类型，业务回执须经 schema 校验。
export type SupportStateSnapshot = Pick<StateSnapshot, "next" | "tasks"> & {
  readonly values: {
    readonly messages?: readonly BaseMessage[];
    readonly supportCompletionReceipt?: unknown;
  };
};
