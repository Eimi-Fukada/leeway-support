import { z } from "zod";

// 此文件同时供服务端和 UI 使用；只有数据契约，不导入模型、数据库或凭据。
const base = {
  key: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)
    .refine(
      (value) => !Object.hasOwn(Object.prototype, value),
      "问题标识不能使用保留名称",
    ),
  label: z.string().trim().min(1).max(120),
  required: z.boolean(),
};
const option = z
  .object({
    value: z.string().min(1).max(80),
    label: z.string().trim().min(1).max(120),
  })
  .strict();
export const informationSpecSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    fields: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ ...base, type: z.literal("text") }).strict(),
          z.object({ ...base, type: z.literal("textarea") }).strict(),
          z
            .object({
              ...base,
              type: z.literal("select"),
              options: z.array(option).min(2).max(10),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(6),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (
      new Set(spec.fields.map((field) => field.key)).size !== spec.fields.length
    )
      ctx.addIssue({
        code: "custom",
        message: "问题标识不能重复",
        path: ["fields"],
      });
    spec.fields.forEach((field, index) => {
      if (
        field.type === "select" &&
        new Set(field.options.map((entry) => entry.value)).size !==
          field.options.length
      )
        ctx.addIssue({
          code: "custom",
          message: "选项值不能重复",
          path: ["fields", index, "options"],
        });
    });
  });
export type InformationSpec = z.infer<typeof informationSpecSchema>;
export const submissionSchema = z
  .object({
    formId: z.uuid(),
    formVersion: z.literal(1),
    submissionId: z.uuid(),
    answers: z.record(z.string(), z.string().max(2000)),
  })
  .strict();
export type InformationSubmission = z.infer<typeof submissionSchema>;
export const informationFormSchema = z
  .object({
    schemaVersion: z.literal(1),
    formId: z.uuid(),
    formVersion: z.literal(1),
    status: z.enum(["draft", "pending", "submitted", "invalidated"]),
    expiresAt: z.iso.datetime(),
    spec: informationSpecSchema,
  })
  .strict();
export type InformationForm = z.infer<typeof informationFormSchema>;

export class InformationError extends Error {
  constructor(message: string) {
    super(`补充信息：${message}`);
    this.name = "InformationError";
  }
}

// 两端均检查，但服务端必须用保存的原始规格重新校验，不能相信浏览器的 schema。
export function validateAnswers(
  spec: InformationSpec,
  answers: Record<string, string>,
): Record<string, string> {
  if (
    Object.keys(answers).some(
      (key) => !spec.fields.some((field) => field.key === key),
    )
  )
    throw new InformationError("包含未知问题，请刷新表单。");
  const result: Record<string, string> = {};
  for (const field of spec.fields) {
    const value = (answers[field.key] ?? "").trim();
    if (field.required && !value)
      throw new InformationError(`请填写“${field.label}”。`);
    if (
      value.length >
      (field.type === "textarea" ? 2000 : field.type === "text" ? 500 : 80)
    )
      throw new InformationError(`“${field.label}”内容过长。`);
    if (
      value &&
      field.type === "select" &&
      !field.options.some((entry) => entry.value === value)
    )
      throw new InformationError(`“${field.label}”选项无效。`);
    if (
      /(?:api[_ -]?key|password|密码|access[_ -]?token)\s*[:=：]\s*\S+|\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+\S+/i.test(
        value,
      )
    )
      throw new InformationError("请删除答案中的密码、密钥或访问令牌。");
    result[field.key] = value;
  }
  return result;
}
