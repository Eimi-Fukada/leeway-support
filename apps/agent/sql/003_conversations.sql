-- 用户可见消息档案与请求账本，与 Agent 内部 checkpoint 分开。
CREATE TABLE IF NOT EXISTS public.support_conversation_requests (
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
ALTER TABLE public.support_conversation_requests ADD COLUMN IF NOT EXISTS request_kind text NOT NULL DEFAULT 'legacy';
ALTER TABLE public.support_conversation_requests ADD COLUMN IF NOT EXISTS metadata_required boolean NOT NULL DEFAULT false;
