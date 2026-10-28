CREATE TABLE IF NOT EXISTS public.knowledge_retrievals (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.knowledge_users(id),
 knowledge_base_id uuid NOT NULL REFERENCES public.knowledge_bases(id),
 query text NOT NULL, scope_revision text NOT NULL, profile_id text,
 status text NOT NULL, candidates jsonb NOT NULL DEFAULT '[]', evidence jsonb NOT NULL DEFAULT '[]',
 elapsed_ms integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_retrievals_scope ON public.knowledge_retrievals(user_id,knowledge_base_id,created_at);
ALTER TABLE public.knowledge_retrievals ADD COLUMN IF NOT EXISTS error_code text;
