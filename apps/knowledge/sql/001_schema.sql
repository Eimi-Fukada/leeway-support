-- Leeway Knowledge：应用自有表；在已存在的产品数据库 public 中执行。
-- 不创建数据库，不修改 Agent checkpoint 或记忆表。
CREATE TABLE IF NOT EXISTS public.knowledge_users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (length(username) BETWEEN 1 AND 64),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.knowledge_sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash)=64),
  user_id uuid NOT NULL REFERENCES public.knowledge_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_sessions_expiry ON public.knowledge_sessions(expires_at);
CREATE INDEX IF NOT EXISTS knowledge_sessions_user ON public.knowledge_sessions(user_id);
CREATE TABLE IF NOT EXISTS public.knowledge_bases (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES public.knowledge_users(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  description text NOT NULL DEFAULT '' CHECK (length(description)<=300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_bases_owner_name ON public.knowledge_bases(owner_id,lower(name));
