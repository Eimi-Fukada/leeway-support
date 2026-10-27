-- 原文已保存不等于已解析/索引。此轮不初始化知识检索任务。
CREATE TABLE IF NOT EXISTS public.knowledge_documents (
  id uuid PRIMARY KEY,
  knowledge_base_id uuid NOT NULL REFERENCES public.knowledge_bases(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  kind text NOT NULL CHECK (kind IN ('pdf','docx','text','markdown')),
  size integer NOT NULL CHECK (size>0 AND size<=10485760),
  sha256 text NOT NULL CHECK (length(sha256)=64),
  storage_key uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(knowledge_base_id,sha256)
);
CREATE INDEX IF NOT EXISTS knowledge_documents_library ON public.knowledge_documents(knowledge_base_id,created_at DESC);
