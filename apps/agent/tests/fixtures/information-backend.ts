import { randomUUID } from "node:crypto";
import { InformationError, informationSpecSchema, validateAnswers, type InformationForm, type InformationSubmission } from "../../src/interactions/contracts.ts";
import type { SupportRunResult } from "../../src/interactions/service.ts";
import type { InformationBackend } from "../../src/interactions/service.ts";

// 只替换产品存储边界；测试仍运行实际 Agent、工具、middleware 和 stream。
export class TestInformationBackend implements InformationBackend {
  forms = new Map<string, InformationForm>();
  created = 0;
  calls = new Map<string, string>();
  results = new Map<string, SupportRunResult>();
  submissions = new Map<string, InformationSubmission>();
  async withThread<T>(_scope: string, _thread: string, work: () => Promise<T>) { return work(); }
  async begin() { for (const form of this.forms.values()) if (form.status !== "submitted") form.status = "invalidated"; }
  async create(_scope: string, _thread: string, run: string, _call: string, input: unknown) {
    if (this.forms.has(run)) {
      if (this.calls.get(run) === _call) return structuredClone(this.forms.get(run)!);
      throw new InformationError("一轮只允许一份表单。");
    }
    const form: InformationForm = { schemaVersion: 1, formId: randomUUID(), formVersion: 1,
      status: "draft", expiresAt: new Date(Date.now() + 1_800_000).toISOString(), spec: informationSpecSchema.parse(input) };
    this.forms.set(run, form); this.calls.set(run, _call); this.created++; return structuredClone(form);
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
  async wait(_scope: string, _thread: string, run: string, id: string, interruptId: string) {
    const form = this.forms.get(run);
    if (!form || form.formId !== id || form.status === "submitted") throw new InformationError("暂停点不匹配。");
    form.status = "pending"; form.interruptId = interruptId;
    return structuredClone(form);
  }
  async replay(_scope: string, _thread: string, submission: InformationSubmission) {
    const previous = this.submissions.get(submission.formId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(submission)) throw new InformationError("不能重复修改。");
      const result = this.results.get(submission.formId);
      if (!result) throw new InformationError("执行结果未确认。");
      return result;
    }
  }
  async accept(_scope: string, _thread: string, submission: InformationSubmission) {
    const form = await this.get(_scope, _thread, submission.formId);
    if (form.status !== "pending" || form.interruptId !== submission.interruptId || Date.parse(form.expiresAt) <= Date.now()) throw new InformationError("表单失效。");
    const answers = submission.cancelled ? {} : validateAnswers(form.spec, submission.answers);
    this.submissions.set(form.formId, structuredClone(submission));
    for (const item of this.forms.values()) if (item.formId === form.formId) item.status = "submitted";
    return { resume: { formId: form.formId, submissionId: submission.submissionId, cancelled: !!submission.cancelled, answers } };
  }
  async record(_scope: string, _thread: string, submission: InformationSubmission, result: SupportRunResult) { this.results.set(submission.formId, result); }
  async confirm(_scope: string, _thread: string, submissionId: string, result: SupportRunResult) {
    for (const [formId, submission] of this.submissions) if (submission.submissionId === submissionId && !this.results.has(formId)) this.results.set(formId, result);
  }
}
