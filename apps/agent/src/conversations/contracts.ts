import { z } from "zod";
import { informationFormSchema } from "../interactions/contracts.ts";

export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const pendingMessageSchema = z.object({ id: requestIdSchema, content: z.string().min(1).max(12_000) }).strict();
export const requestStatusSchema = z.enum(["running", "waiting_for_input", "completed", "failed", "unknown"]);
export const conversationSnapshotSchema = z.object({
  status: z.enum(["empty", "running", "waiting_for_input", "completed", "failed", "unknown"]),
  historyComplete: z.boolean(),
  messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]), content: z.string() })),
  requests: z.array(z.object({ requestId: z.string(), runId: z.string(), status: requestStatusSchema, updatedAt: z.string() })),
  information: informationFormSchema.optional(),
  notice: z.string().optional(),
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

export function canSendConversationMessage(status: ConversationSnapshot["status"]) {
  return status === "empty" || status === "completed";
}

export class ConversationError extends Error {
  constructor(message: string) { super(`会话记录：${message}`); this.name = "ConversationError"; }
}
