import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(256),
}).strict();
export const knowledgeInputSchema = z.object({
  name: z.string().trim().min(1, "请填写知识库名称。").max(60, "名称最多 60 个字符。"),
  description: z.string().trim().max(300, "描述最多 300 个字符。").default(""),
}).strict();
export interface User { id: string; username: string }
export interface KnowledgeBase { id: string; name: string; description: string; createdAt: string; documentCount?: number }
export class AppError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "KnowledgeError"; }
}
