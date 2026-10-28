-- 当前处理阶段扩展到“分块完成，等待向量化”；不启动模型或建立向量索引。
ALTER TABLE public.knowledge_documents DROP CONSTRAINT IF EXISTS knowledge_documents_processing_status_check;
ALTER TABLE public.knowledge_documents DROP CONSTRAINT IF EXISTS knowledge_documents_processing_consistency;
ALTER TABLE public.knowledge_documents DROP CONSTRAINT IF EXISTS knowledge_documents_kind_check;
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_kind_check CHECK (length(kind) BETWEEN 1 AND 64);
ALTER TABLE public.knowledge_documents DROP CONSTRAINT IF EXISTS knowledge_documents_processing_error_code_check;
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_processing_error_code_check CHECK (
  processing_error_code IN ('read_failed','parse_failed','chunk_failed','embedding_failed','index_failed','interrupted','result_unknown','empty_text','text_too_large')
);
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_processing_status_check
  CHECK (processing_status IN ('pending','parsing','chunking','chunked','embedding','embedded','indexing','ready','failed','unsupported'));
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_processing_consistency CHECK (
  (processing_status='failed' AND processing_failed_stage IS NOT NULL AND processing_error_code IS NOT NULL)
  OR (processing_status<>'failed' AND processing_failed_stage IS NULL AND processing_error_code IS NULL)
);
ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS processing_run_id uuid,
  ADD COLUMN IF NOT EXISTS processing_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_attempt integer NOT NULL DEFAULT 0 CHECK (processing_attempt>=0);
-- 仅将从未处理的旧 DOCX 开放给新适配器，不重置失败或完成记录。
UPDATE public.knowledge_documents SET processing_status='pending'
WHERE kind='docx' AND processing_status='unsupported';
CREATE INDEX IF NOT EXISTS knowledge_documents_pending ON public.knowledge_documents(created_at,id) WHERE processing_status='pending';

CREATE TABLE IF NOT EXISTS public.knowledge_document_contents (
  document_id uuid PRIMARY KEY REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  source_sha256 text NOT NULL,
  parser_id text NOT NULL, parser_version text NOT NULL,
  text text NOT NULL CHECK (length(btrim(text))>0),
  sections jsonb NOT NULL CHECK (jsonb_typeof(sections)='array'),
  warnings jsonb NOT NULL CHECK (jsonb_typeof(warnings)='array'),
  splitter_config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.knowledge_document_chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES public.knowledge_document_contents(document_id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal>=0),
  text text NOT NULL CHECK (length(btrim(text))>0),
  heading_path jsonb NOT NULL CHECK (jsonb_typeof(heading_path)='array'),
  section_index integer NOT NULL CHECK (section_index>=0),
  start_offset integer NOT NULL CHECK (start_offset>=0),
  end_offset integer NOT NULL CHECK (end_offset>start_offset),
  content_sha256 text NOT NULL,
  UNIQUE(document_id,ordinal)
);
