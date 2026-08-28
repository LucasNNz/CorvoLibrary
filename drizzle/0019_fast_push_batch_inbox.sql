-- V61.1: FAST PUSH BATCH + Inbox de candidatas.
CREATE TABLE IF NOT EXISTS fast_push_candidates (
  id text PRIMARY KEY NOT NULL,
  operation_id text NOT NULL,
  batch_id text,
  project_id text,
  item_id text,
  slot text,
  target_name text,
  source_url text NOT NULL,
  source_type text DEFAULT 'WEB' NOT NULL,
  universe text,
  subject text,
  concept text,
  visual_reference text,
  script_reference text,
  scene text,
  arc text,
  episode_candidate text,
  composition_class text,
  tags text DEFAULT '[]' NOT NULL,
  used_for text,
  priority integer DEFAULT 1 NOT NULL,
  search_metadata text DEFAULT '{}' NOT NULL,
  status text DEFAULT 'INGESTING' NOT NULL,
  failure_reason text,
  sha256 text,
  r2_key text,
  mime_type text,
  size_bytes integer,
  asset_id text REFERENCES assets(id),
  duplicate_of_candidate_id text,
  decision_source text,
  decision_note text,
  analyzed_at integer,
  promoted_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS fast_push_candidates_operation_id_unique ON fast_push_candidates(operation_id);
CREATE INDEX IF NOT EXISTS fast_push_candidates_inbox_idx ON fast_push_candidates(status, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS fast_push_candidates_project_slot_idx ON fast_push_candidates(project_id, item_id, slot, status);
CREATE INDEX IF NOT EXISTS fast_push_candidates_sha_idx ON fast_push_candidates(sha256, status);
CREATE INDEX IF NOT EXISTS fast_push_candidates_batch_idx ON fast_push_candidates(batch_id, status, created_at DESC);
