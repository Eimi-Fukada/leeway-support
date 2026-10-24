import { InformationError, informationInterruptSchema } from "./contracts.ts";

// 只恢复本产品自己定义的单个补资料暂停点；异常步骤/未知 interrupt 继续拒绝自动执行。
export function informationPause(state: {
  next: readonly string[];
  tasks?: readonly { error?: unknown; interrupts?: readonly { id?: string; value?: unknown }[] }[];
}) {
  if (state.tasks?.some((task) => task.error)) throw new InformationError("会话存在失败步骤，不能自动恢复，请新建会话。");
  const interrupts = state.tasks?.flatMap((task) => task.interrupts ?? []) ?? [];
  if (!interrupts.length) {
    if (state.next.length) throw new InformationError("会话存在未确认步骤，不能自动重试，请新建会话。");
    return undefined;
  }
  const first = interrupts[0]!;
  const payload = informationInterruptSchema.safeParse(first.value);
  if (interrupts.length !== 1 || !first.id || !payload.success) throw new InformationError("未知或多个暂停点，不能自动恢复。");
  return { id: first.id, ...payload.data };
}
