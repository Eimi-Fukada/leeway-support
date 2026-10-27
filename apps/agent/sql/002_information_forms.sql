CREATE TABLE IF NOT EXISTS public.support_information_forms (
  id uuid PRIMARY KEY, scope text NOT NULL, thread_id text NOT NULL, run_id uuid NOT NULL,
  tool_call_id text NOT NULL, spec jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('draft','pending','submitted','invalidated')),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  submission_id uuid, submission_hash text, result jsonb,
  UNIQUE(scope, thread_id, run_id)
);
ALTER TABLE public.support_information_forms ADD COLUMN IF NOT EXISTS interrupt_id text;
CREATE INDEX IF NOT EXISTS support_information_forms_thread ON public.support_information_forms(scope, thread_id);
