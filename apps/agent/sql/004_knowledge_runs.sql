CREATE TABLE IF NOT EXISTS public.support_service_nonces(caller text NOT NULL, nonce uuid NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(caller,nonce));
CREATE TABLE IF NOT EXISTS public.support_knowledge_threads(scope text NOT NULL,thread_id text NOT NULL,base_id uuid NOT NULL,revision text NOT NULL,PRIMARY KEY(scope,thread_id));
CREATE TABLE IF NOT EXISTS public.support_run_options(scope text NOT NULL,thread_id text NOT NULL,request_id text NOT NULL,options jsonb NOT NULL,PRIMARY KEY(scope,thread_id,request_id));
