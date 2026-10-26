import type pg from "pg";
import type { SupportRunResult } from "../interactions/service.ts";
import { ConversationError, requestIdSchema, type ConversationSnapshot } from "./contracts.ts";

export interface RequestRecord {
  kind: "message" | "resume" | "legacy";
  requestId: string; runId: string; payloadHash: string; status: "running" | "waiting_for_input" | "completed" | "failed" | "unknown";
  result: SupportRunResult | null; updatedAt: string;
}

// 与 checkpoint 分离：这里存用户可见的档案和接收请求，不存内部推理/系统消息/工具结果。
export class ConversationService {
  constructor(private readonly pool: pg.Pool) {}
  async setup() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(461992304)");
      await client.query(`CREATE TABLE IF NOT EXISTS public.support_conversation_requests (
      scope text NOT NULL, thread_id text NOT NULL, request_id text NOT NULL, run_id uuid NOT NULL,
      payload_hash text NOT NULL, status text NOT NULL CHECK(status IN ('running','waiting_for_input','completed','failed','unknown')),
      history_complete boolean NOT NULL DEFAULT true,
      request_kind text NOT NULL DEFAULT 'legacy',
      result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      sequence bigserial, PRIMARY KEY(scope,thread_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS public.support_conversation_messages (
      scope text NOT NULL, thread_id text NOT NULL, id text NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant')),
      content text NOT NULL, request_id text NOT NULL, sequence bigserial,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,thread_id,id)
    );
    ALTER TABLE public.support_conversation_requests ADD COLUMN IF NOT EXISTS history_complete boolean NOT NULL DEFAULT true;
    ALTER TABLE public.support_conversation_requests ADD COLUMN IF NOT EXISTS request_kind text NOT NULL DEFAULT 'legacy';`);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async find(scope: string, thread: string, requestId: string): Promise<RequestRecord | undefined> {
    const rows = await this.pool.query(`SELECT request_kind AS kind,request_id AS "requestId",run_id AS "runId",payload_hash AS "payloadHash",status,result,
      updated_at AS "updatedAt" FROM public.support_conversation_requests WHERE scope=$1 AND thread_id=$2 AND request_id=$3`, [scope, thread, requestId]);
    return rows.rows[0] ? { ...rows.rows[0], updatedAt: rows.rows[0].updatedAt.toISOString() } : undefined;
  }

  async start(scope: string, thread: string, requestId: string, runId: string, payloadHash: string, content: string, historyComplete = true, kind: RequestRecord["kind"] = "legacy") {
    requestIdSchema.parse(requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO public.support_conversation_requests(scope,thread_id,request_id,run_id,payload_hash,status,history_complete,request_kind)
        VALUES($1,$2,$3,$4,$5,'running',$6,$7)`, [scope, thread, requestId, runId, payloadHash, historyComplete, kind]);
      await client.query(`INSERT INTO public.support_conversation_messages(scope,thread_id,id,role,content,request_id)
        VALUES($1,$2,$3,'user',$4,$3)`, [scope, thread, requestId, content]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async finish(scope: string, thread: string, requestId: string, result: SupportRunResult) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await client.query(`UPDATE public.support_conversation_requests SET status=$4,result=$5,updated_at=now()
        WHERE scope=$1 AND thread_id=$2 AND request_id=$3 RETURNING request_id`, [scope, thread, requestId, result.status, result]);
      if (!saved.rowCount) throw new ConversationError("请求记录不存在，不能确认完成。");
      if (result.status === "completed") await client.query(`INSERT INTO public.support_conversation_messages(scope,thread_id,id,role,content,request_id)
        VALUES($1,$2,$3,'assistant',$4,$5) ON CONFLICT(scope,thread_id,id) DO NOTHING`, [scope, thread, `assistant-${requestId}`, result.answer, requestId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async uncertain(scope: string, thread: string, requestId: string, status: "failed" | "unknown") {
    await this.pool.query(`UPDATE public.support_conversation_requests SET status=$4,updated_at=now()
      WHERE scope=$1 AND thread_id=$2 AND request_id=$3 AND status IN ('running','unknown')`, [scope, thread, requestId, status]);
  }

  async history(scope: string, thread: string): Promise<Pick<ConversationSnapshot, "messages" | "requests" | "historyComplete">> {
    const messages = await this.pool.query(`SELECT id,role,content FROM public.support_conversation_messages WHERE scope=$1 AND thread_id=$2 ORDER BY sequence`, [scope, thread]);
    const requests = await this.pool.query(`SELECT request_id AS "requestId",run_id AS "runId",status,updated_at AS "updatedAt"
      ,history_complete FROM public.support_conversation_requests WHERE scope=$1 AND thread_id=$2 ORDER BY sequence`, [scope, thread]);
    return { messages: messages.rows, historyComplete: requests.rows.every((row) => row.history_complete),
      requests: requests.rows.map(({ history_complete, ...row }) => ({ ...row, updatedAt: row.updatedAt.toISOString() })) };
  }
}
export type ConversationBackend = Pick<ConversationService, "find" | "start" | "finish" | "uncertain" | "history">;
