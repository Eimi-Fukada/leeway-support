-- 保存写入目标与读回核对回执；不把 PostgreSQL 与 Qdrant 当作一个原子事务。
ALTER TABLE public.knowledge_documents
 ADD COLUMN IF NOT EXISTS index_target jsonb CHECK(index_target IS NULL OR jsonb_typeof(index_target)='object'),
 ADD COLUMN IF NOT EXISTS index_receipt jsonb CHECK(index_receipt IS NULL OR jsonb_typeof(index_receipt)='object');
CREATE INDEX IF NOT EXISTS knowledge_documents_embedded ON public.knowledge_documents(processing_updated_at,id) WHERE processing_status='embedded';
