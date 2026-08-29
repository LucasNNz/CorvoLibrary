-- V56 — FAST CONTROL PLANE + PARALLEL DATA PLANE

ALTER TABLE automatic_projects ADD COLUMN state_version integer NOT NULL DEFAULT 1;
ALTER TABLE automatic_projects ADD COLUMN total_items integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN approved_count integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN frozen_count integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN collecting_count integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN materializing_count integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN waiting_qa_count integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN relink_count integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN technical_count integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN waiting_seed_count integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN failed_count integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN pending_count integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN last_frozen_at integer;

ALTER TABLE mcp_audit ADD COLUMN request_id text;
ALTER TABLE mcp_audit ADD COLUMN started_at integer;
ALTER TABLE mcp_audit ADD COLUMN finished_at integer;
ALTER TABLE mcp_audit ADD COLUMN duration_ms integer;
ALTER TABLE mcp_audit ADD COLUMN auth_ms integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN parse_ms integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN db_ms integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN db_query_count integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN r2_ms integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN r2_request_count integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN external_http_ms integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN external_http_count integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN serialization_ms integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN queue_ms integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN response_bytes integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN rows_read integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN rows_written integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN cache_hit integer NOT NULL DEFAULT 0;
ALTER TABLE mcp_audit ADD COLUMN cold_start integer NOT NULL DEFAULT 0;

CREATE TABLE operation_results (
  operation_id text PRIMARY KEY NOT NULL,
  tool text NOT NULL,
  project_id text,
  status text NOT NULL DEFAULT 'RUNNING',
  result_json text,
  error text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE TABLE source_route_metrics (
  id text PRIMARY KEY NOT NULL,
  universe text NOT NULL DEFAULT '*',
  composition_class text NOT NULL DEFAULT '*',
  source_id text,
  source_name text NOT NULL,
  host text NOT NULL DEFAULT '*',
  attempts integer NOT NULL DEFAULT 0,
  materialized integer NOT NULL DEFAULT 0,
  approved integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  technical_failures integer NOT NULL DEFAULT 0,
  semantic_failures integer NOT NULL DEFAULT 0,
  total_duration_ms integer NOT NULL DEFAULT 0,
  score integer NOT NULL DEFAULT 0,
  updated_at integer NOT NULL
);


-- Legacy V45/V54 default was 3. Raise only the untouched legacy default to the safe
-- global materialization capacity; explicit user tuning is preserved.
UPDATE settings SET value='8', updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
WHERE key='collection_parallelism' AND value='3';
INSERT OR IGNORE INTO settings(key,value,updated_at)
VALUES('collection_parallelism','8',CAST(strftime('%s','now') AS INTEGER)*1000);

-- Hot-path D1 indexes: queue, snapshots, deltas, QA, candidates, events and leases.
CREATE INDEX IF NOT EXISTS idx_projects_status_domain_ready ON automatic_projects(status, project_domain, ready_at, created_at);
CREATE INDEX IF NOT EXISTS idx_projects_pipeline_version ON automatic_projects(pipeline_status, state_version, updated_at);
CREATE INDEX IF NOT EXISTS idx_project_items_project_status_priority ON automatic_project_items(project_id, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_project_items_project_target ON automatic_project_items(project_id, target_file);
CREATE INDEX IF NOT EXISTS idx_project_items_project_updated ON automatic_project_items(project_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_project_items_status_stage_ready ON automatic_project_items(status, stage_ready_at, priority, id);
CREATE INDEX IF NOT EXISTS idx_supervisor_candidates_project_status_created ON supervisor_project_candidates(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_supervisor_candidates_item_status_created ON supervisor_project_candidates(item_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_project_state_priority ON supervisor_decision_queue(project_id, state, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_materialization_items_batch_status ON materialization_items(batch_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_materialization_candidates_item_status_priority ON materialization_candidates(item_db_id, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_materialization_files_item_created ON materialization_files(item_db_id, created_at);
CREATE INDEX IF NOT EXISTS idx_collection_terms_batch_status ON collection_terms(batch_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_collection_candidates_term_status_created ON collection_candidates(term_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_collection_candidates_batch_status_created ON collection_candidates(batch_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_collection_runs_term_created ON collection_source_runs(term_id, created_at);
CREATE INDEX IF NOT EXISTS idx_assets_universe_kind_qa ON assets(universe, kind, qa_status);
CREATE INDEX IF NOT EXISTS idx_assets_status_updated ON assets(status, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_assets_semantic_qa ON assets(semantic_family, qa_status);
CREATE INDEX IF NOT EXISTS idx_worker_items_queue_fifo ON worker_work_items(stage, project_domain, status, priority DESC, resume_priority DESC, original_ready_at ASC, attempts ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_worker_items_lease_expiry ON worker_work_items(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_worker_sessions_active_type_domain ON worker_sessions(status, worker_type, worker_domain, updated_at);
CREATE INDEX IF NOT EXISTS idx_worker_events_project_created ON worker_events(project_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_worker_events_type_created ON worker_events(event_type, created_at, id);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_duration ON mcp_audit(duration_ms, created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_tool_created ON mcp_audit(tool, created_at);
CREATE INDEX IF NOT EXISTS idx_operation_results_project_updated ON operation_results(project_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_route_metric_unique ON source_route_metrics(universe, composition_class, source_name, host);
CREATE INDEX IF NOT EXISTS idx_source_route_score ON source_route_metrics(universe, composition_class, score, updated_at);
