import { randomUUID } from "node:crypto";
import { InformationError, informationSpecSchema, type InformationForm } from "../../src/interactions/contracts.ts";
import type { InformationBackend } from "../../src/interactions/service.ts";

// 只替换产品存储边界；测试仍运行实际 Agent、工具、middleware 和 stream。
export class TestInformationBackend implements InformationBackend {
  forms = new Map<string, InformationForm>();
  created = 0;
  async withThread<T>(_scope: string, _thread: string, work: () => Promise<T>) { return work(); }
  async begin() { for (const form of this.forms.values()) if (form.status !== "submitted") form.status = "invalidated"; }
  async create(_scope: string, _thread: string, run: string, _call: string, input: unknown) {
    if (this.forms.has(run)) throw new InformationError("一轮只允许一份表单。");
    const form: InformationForm = { schemaVersion: 1, formId: randomUUID(), formVersion: 1,
      status: "draft", expiresAt: new Date(Date.now() + 1_800_000).toISOString(), spec: informationSpecSchema.parse(input) };
    this.forms.set(run, form); this.created++; return structuredClone(form);
  }
  async finish(_scope: string, _thread: string, run: string, success: boolean) {
    const form = this.forms.get(run);
    if (form) { form.status = success ? "pending" : "invalidated"; return structuredClone(form); }
  }
  async get(_scope: string, _thread: string, id: string) {
    const form = [...this.forms.values()].find((form) => form.formId === id);
    if (!form) throw new InformationError("表单不可用。");
    return structuredClone(form);
  }
  async accept(): Promise<never> { throw new Error("提交事务由真实 PostgreSQL 测试验证"); }
  async record() {}
}
