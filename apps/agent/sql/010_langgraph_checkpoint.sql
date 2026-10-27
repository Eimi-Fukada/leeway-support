-- Generated from @langchain/langgraph-checkpoint-postgres 1.1.2 getMigrations(public).
-- Do not edit by hand. Regenerate and review after SDK upgrades.
-- This file manages its own transaction; do not wrap it in another transaction.
BEGIN;
SELECT pg_advisory_xact_lock(461992306);

-- Official migration 0
CREATE TABLE IF NOT EXISTS "public".checkpoint_migrations (
    v INTEGER PRIMARY KEY
  );
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.checkpoint_migrations WHERE v > 5) THEN
    RAISE EXCEPTION 'Checkpoint database is newer than this SQL snapshot; use the matching SDK.';
  END IF;
END $$;
INSERT INTO public.checkpoint_migrations(v) VALUES (0) ON CONFLICT(v) DO NOTHING;

-- Official migration 1
CREATE TABLE IF NOT EXISTS "public".checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,
    checkpoint JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
  );
INSERT INTO public.checkpoint_migrations(v) VALUES (1) ON CONFLICT(v) DO NOTHING;

-- Official migration 2
CREATE TABLE IF NOT EXISTS "public".checkpoint_blobs (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL,
    version TEXT NOT NULL,
    type TEXT NOT NULL,
    blob BYTEA,
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
  );
INSERT INTO public.checkpoint_migrations(v) VALUES (2) ON CONFLICT(v) DO NOTHING;

-- Official migration 3
CREATE TABLE IF NOT EXISTS "public".checkpoint_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT,
    blob BYTEA NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
  );
INSERT INTO public.checkpoint_migrations(v) VALUES (3) ON CONFLICT(v) DO NOTHING;

-- Official migration 4
ALTER TABLE "public".checkpoint_blobs ALTER COLUMN blob DROP not null;
INSERT INTO public.checkpoint_migrations(v) VALUES (4) ON CONFLICT(v) DO NOTHING;

-- Official migration 5
ALTER TABLE "public".checkpoint_writes ADD COLUMN IF NOT EXISTS task_path TEXT NOT NULL DEFAULT '';
INSERT INTO public.checkpoint_migrations(v) VALUES (5) ON CONFLICT(v) DO NOTHING;

COMMIT;
