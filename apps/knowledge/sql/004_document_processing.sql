-- 文档当前处理结果属于业务状态；不建立 SQL 执行账本或任务队列。
ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending','parsing','chunking','embedding','indexing','ready','failed','unsupported')),
  ADD COLUMN IF NOT EXISTS processing_failed_stage text
    CHECK (processing_failed_stage IN ('parsing','chunking','embedding','indexing')),
  ADD COLUMN IF NOT EXISTS processing_error_code text
    CHECK (processing_error_code IN ('read_failed','parse_failed','chunk_failed','embedding_failed','index_failed','interrupted','result_unknown')),
  ADD COLUMN IF NOT EXISTS processing_updated_at timestamptz NOT NULL DEFAULT now();

-- 旧 PDF/Word 仍可预览原文，本轮只有文本入库契约；不重置已有处理结果。
UPDATE public.knowledge_documents SET processing_status='unsupported'
WHERE kind NOT IN ('text','markdown') AND processing_status='pending';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.knowledge_documents'::regclass
                 AND conname='knowledge_documents_processing_consistency') THEN
    ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_processing_consistency CHECK (
      ((processing_status='failed' AND processing_failed_stage IS NOT NULL AND processing_error_code IS NOT NULL)
       OR (processing_status<>'failed' AND processing_failed_stage IS NULL AND processing_error_code IS NULL))
      AND ((kind IN ('text','markdown') AND processing_status<>'unsupported')
        OR (kind NOT IN ('text','markdown') AND processing_status='unsupported'))
    );
  END IF;
END $$;
