import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const supportContextSchema = z
  .object({
    identitySource: z.enum(["local-development", "business-authenticated"]),
    integrationId: identifier, // 接入的业务系统
    productId: identifier,
    subject: z
      .object({ kind: z.enum(["user", "anonymous"]), id: identifier })
      .strict(),
  })
  .strict();
export type SupportContext = z.infer<typeof supportContextSchema>;

// 结构校验不是身份认证。业务后端只能在验证自己的登录/令牌后构造此服务端契约。
export function validateSupportContext(input: unknown): SupportContext {
  const parsed = supportContextSchema.safeParse(input);
  if (!parsed.success)
    throw new Error("身份上下文无效：需要来源、接入系统、产品和用户归属。");
  return Object.freeze({
    ...parsed.data,
    subject: Object.freeze(parsed.data.subject),
  });
}

export function memoryScope(context: SupportContext): string {
  const valid = validateSupportContext(context);
  // 产品内隔离；不同业务系统里的相同用户编号并不代表同一个人。
  return createHash("sha256").update(JSON.stringify(valid)).digest("hex");
}

export function checkpointThreadId(
  threadId: string,
  context?: SupportContext,
): string {
  return context ? `support-${memoryScope(context)}-${threadId}` : threadId;
}

export function localSupportContext(userId: string): SupportContext {
  return validateSupportContext({
    identitySource: "local-development",
    integrationId: "local-cli",
    productId: "support",
    subject: { kind: "user", id: userId },
  });
}
