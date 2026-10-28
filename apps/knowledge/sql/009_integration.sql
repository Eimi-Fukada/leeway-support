CREATE TABLE IF NOT EXISTS public.knowledge_service_nonces(caller text NOT NULL, nonce uuid NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(caller,nonce));
CREATE TABLE IF NOT EXISTS public.knowledge_application_grants(application_id text NOT NULL, knowledge_base_id uuid NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE, active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1, PRIMARY KEY(application_id,knowledge_base_id));
ALTER TABLE public.knowledge_application_grants DROP CONSTRAINT IF EXISTS knowledge_application_grants_knowledge_base_id_fkey;
ALTER TABLE public.knowledge_application_grants ADD CONSTRAINT knowledge_application_grants_knowledge_base_id_fkey FOREIGN KEY(knowledge_base_id) REFERENCES public.knowledge_bases(id) ON DELETE CASCADE;
