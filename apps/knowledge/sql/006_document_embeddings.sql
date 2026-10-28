-- 保存待写入 Qdrant 的向量结果，不引入 pgvector 或自有迁移账本。
ALTER TABLE public.knowledge_documents DROP CONSTRAINT IF EXISTS knowledge_documents_processing_status_check;
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_processing_status_check
 CHECK (processing_status IN ('pending','parsing','chunking','chunked','embedding','embedded','indexing','ready','failed','unsupported'));
ALTER TABLE public.knowledge_documents ADD COLUMN IF NOT EXISTS embedding_profile jsonb
 CHECK (embedding_profile IS NULL OR jsonb_typeof(embedding_profile)='object');
ALTER TABLE public.knowledge_document_chunks ADD COLUMN IF NOT EXISTS embedding jsonb
 CHECK (embedding IS NULL OR (jsonb_typeof(embedding)='array' AND jsonb_array_length(embedding)>0));
CREATE INDEX IF NOT EXISTS knowledge_documents_chunked ON public.knowledge_documents(processing_updated_at,id) WHERE processing_status='chunked';
