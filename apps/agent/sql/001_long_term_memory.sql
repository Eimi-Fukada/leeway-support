CREATE TABLE IF NOT EXISTS public.support_memories (
  scope text NOT NULL, id uuid NOT NULL, version integer NOT NULL CHECK (version > 0),
  content text NOT NULL, deleted boolean NOT NULL DEFAULT false, source jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, id)
);
CREATE TABLE IF NOT EXISTS public.support_memory_operations (
  scope text NOT NULL, operation_id text NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (scope, operation_id)
);
