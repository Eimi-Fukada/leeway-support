import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { informationSpecSchema, submissionSchema, InformationError, validateAnswers, type InformationForm, type InformationSpec, type InformationSubmission, type InformationReply } from "./contracts.ts";
import { redactPii } from "../agent/middleware/pii.ts";

export interface SupportRunResult { answer: string; elapsedMs: number; runId: string; status: "completed" | "waiting_for_input"; information?: InformationForm }
// 执行层依赖这些能力；测试可注入无数据库实现，真实入口始终使用 PostgreSQL。
export type InformationBackend = Pick<InformationService, "withThread" | "begin" | "create" | "finish" | "get" | "accept" | "record" | "wait" | "replay">;
interface Row { id: string; scope: string; thread_id: string; run_id: string; tool_call_id: string;
  spec: InformationSpec; status: InformationForm["status"]; expires_at: Date;
  submission_id: string | null; submission_hash: string | null; result: SupportRunResult | null; interrupt_id: string | null }

// 表单是产品交互记录，和模型 messages/checkpoint 分开；同一会话锁覆盖校验、提交及执行。
export class InformationService {
  constructor(private readonly pool: pg.Pool) {}

  async setup() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS public.support_information_forms (
      id uuid PRIMARY KEY, scope text NOT NULL, thread_id text NOT NULL, run_id uuid NOT NULL,
      tool_call_id text NOT NULL, spec jsonb NOT NULL,
      status text NOT NULL CHECK(status IN ('draft','pending','submitted','invalidated')),
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      submission_id uuid, submission_hash text, result jsonb,
      UNIQUE(scope, thread_id, run_id)
    )`);
    await this.pool.query("ALTER TABLE public.support_information_forms ADD COLUMN IF NOT EXISTS interrupt_id text");
    await this.pool.query(`CREATE INDEX IF NOT EXISTS support_information_forms_thread
      ON public.support_information_forms(scope, thread_id)`);
  }

  async withThread<T>(scope: string, threadId: string, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const lock = `${scope}:${threadId}`;
    let held = false;
    try {
      const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held", [lock]);
      held = result.rows[0].held;
      if (!held) throw new InformationError("当前会话正在处理，请稍后再试。");
      return await work();
    } finally {
      // 解锁失败时销毁连接，避免把持锁连接放回池中。
      let destroy = false;
      try { if (held) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lock]); }
      catch { destroy = true; throw new InformationError("会话连接异常，请新建会话。"); }
      finally { client.release(destroy); }
    }
  }

  async begin(scope: string, threadId: string) {
    await this.pool.query("UPDATE public.support_information_forms SET status='invalidated' WHERE scope=$1 AND thread_id=$2 AND status IN ('draft','pending')", [scope, threadId]);
  }

  async create(scope: string, threadId: string, runId: string, toolCallId: string, input: unknown): Promise<InformationForm> {
    const parsed = informationSpecSchema.safeParse(input);
    if (!parsed.success) throw new InformationError("表单结构无效，未创建表单。");
    // 标题和提示同样可能含个人信息；进入应用存储前复用输入脱敏规则。
    const spec = informationSpecSchema.parse(JSON.parse(redactPii(JSON.stringify(parsed.data))));
    const inserted = await this.pool.query<Row>(`INSERT INTO public.support_information_forms
      (id,scope,thread_id,run_id,tool_call_id,spec,status,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'draft',now()+interval '30 minutes')
      ON CONFLICT(scope,thread_id,run_id) DO NOTHING RETURNING *`, [randomUUID(), scope, threadId, runId, toolCallId, spec]);
    if (!inserted.rows[0]) {
      const previous = await this.pool.query<Row>("SELECT * FROM public.support_information_forms WHERE scope=$1 AND thread_id=$2 AND run_id=$3", [scope, threadId, runId]);
      const row = previous.rows[0];
      if (row?.tool_call_id === toolCallId && isDeepStrictEqual(row.spec, spec) && ["draft", "pending", "submitted"].includes(row.status)) return this.view(row);
      throw new InformationError("一个逻辑任务只允许提出一份补充信息表单，请合并问题。");
    }
    return this.view(inserted.rows[0]);
  }

  async wait(scope: string, threadId: string, runId: string, formId: string, interruptId: string): Promise<InformationForm> {
    const result = await this.pool.query<Row>(`UPDATE public.support_information_forms SET status='pending',interrupt_id=$5
      WHERE scope=$1 AND thread_id=$2 AND run_id=$3 AND id=$4 AND status IN ('draft','pending')
      AND (interrupt_id IS NULL OR interrupt_id=$5) RETURNING *`, [scope, threadId, runId, formId, interruptId]);
    if (!result.rows[0]) throw new InformationError("暂停点与表单不匹配，不能继续。");
    return this.get(scope, threadId, formId);
  }


  async finish(scope: string, threadId: string, runId: string, success: boolean): Promise<InformationForm | undefined> {
    const result = await this.pool.query<Row>(`UPDATE public.support_information_forms SET status=$4
      WHERE scope=$1 AND thread_id=$2 AND run_id=$3 AND status IN ('draft', 'pending') RETURNING *`,
    [scope, threadId, runId, success ? "pending" : "invalidated"]);
    return result.rows[0] ? this.view(result.rows[0]) : undefined;
  }

  async get(scope: string, threadId: string, formId: string): Promise<InformationForm> {
    const row = await this.read(scope, threadId, formId);
    if (row.expires_at.getTime() <= Date.now() && row.status === "pending") return { ...this.view(row), status: "invalidated" };
    return this.view(row);
  }

  private submissionHash(row: Row, submission: InformationSubmission) {
    if (row.interrupt_id !== submission.interruptId) throw new InformationError("暂停点已变化，请刷新表单。");
    if (submission.cancelled && Object.keys(submission.answers).length) throw new InformationError("取消请求不能携带答案。");
    const answers = submission.cancelled ? {} : validateAnswers(row.spec, submission.answers);
    const ordered = row.spec.fields.map((field) => [field.key, answers[field.key] ?? ""]);
    return { answers, hash: createHash("sha256").update(JSON.stringify({ ordered, cancelled: !!submission.cancelled })).digest("hex") };
  }

  async replay(scope: string, threadId: string, submission: InformationSubmission): Promise<SupportRunResult | undefined> {
    submission = submissionSchema.parse(submission);
    const row = await this.read(scope, threadId, submission.formId);
    const { hash } = this.submissionHash(row, submission);
    if (row.status !== "submitted") return undefined;
    if (row.submission_id !== submission.submissionId || row.submission_hash !== hash) throw new InformationError("该表单已提交，不能重复修改。");
    if (!row.result) throw new InformationError("资料已接收，但执行结果未确认；不会自动重试，请新建会话。");
    return row.result;
  }

  async accept(scope: string, threadId: string, submission: InformationSubmission): Promise<{ resume: InformationReply } | { replay: SupportRunResult }> {
    submission = submissionSchema.parse(submission);
    const row = await this.read(scope, threadId, submission.formId);
    const { answers, hash } = this.submissionHash(row, submission);
    if (row.status === "submitted") {
      if (row.submission_id !== submission.submissionId || row.submission_hash !== hash)
        throw new InformationError("该表单已提交，不能重复修改。");
      if (!row.result) throw new InformationError("资料已接收，但执行结果未确认；不会自动重试，请新建会话。");
      return { replay: row.result };
    }
    if (row.status !== "pending" || row.expires_at.getTime() <= Date.now())
      throw new InformationError("表单已失效，请重新描述问题。");
    const update = await this.pool.query(`UPDATE public.support_information_forms
      SET status='submitted',submission_id=$4,submission_hash=$5
      WHERE id=$1 AND scope=$2 AND thread_id=$3 AND status='pending' AND expires_at>now() RETURNING id`,
    [row.id, scope, threadId, submission.submissionId, hash]);
    if (!update.rowCount) throw new InformationError("表单已失效，请重新描述问题。");
    // 在 resume 值写入 checkpoint 前处理 PII；工具恢复后按原规格再次校验。
    return { resume: { formId: row.id, submissionId: submission.submissionId, cancelled: !!submission.cancelled,
      answers: JSON.parse(redactPii(JSON.stringify(answers))) } };
  }

  async record(scope: string, threadId: string, submission: InformationSubmission, result: SupportRunResult) {
    const recorded = await this.pool.query(`UPDATE public.support_information_forms SET result=$5
      WHERE id=$1 AND scope=$2 AND thread_id=$3 AND submission_id=$4 AND status='submitted'`,
    [submission.formId, scope, threadId, submission.submissionId, result]);
    if (!recorded.rowCount) throw new InformationError("执行结果未能确认保存；不会自动重复恢复。");
  }

  private async read(scope: string, threadId: string, id: string): Promise<Row> {
    const result = await this.pool.query<Row>("SELECT * FROM public.support_information_forms WHERE id=$1 AND scope=$2 AND thread_id=$3", [id, scope, threadId]);
    if (!result.rows[0]) throw new InformationError("表单不可用。");
    return result.rows[0];
  }
  private view(row: Row): InformationForm {
    return { schemaVersion: 1, formId: row.id, formVersion: 1, status: row.status,
      expiresAt: row.expires_at.toISOString(), ...(row.interrupt_id ? { interruptId: row.interrupt_id } : {}), spec: informationSpecSchema.parse(row.spec) };
  }
}
