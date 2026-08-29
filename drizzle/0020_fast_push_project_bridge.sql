-- V61.2: FAST PUSH passa pela mesma ponte canônica de QA/Pendentes do Supervisor.
ALTER TABLE fast_push_candidates ADD COLUMN project_item_id text;
ALTER TABLE fast_push_candidates ADD COLUMN project_link_status text;
ALTER TABLE fast_push_candidates ADD COLUMN materialization_batch_id text;
ALTER TABLE fast_push_candidates ADD COLUMN materialization_item_id text;
ALTER TABLE fast_push_candidates ADD COLUMN materialization_file_id text;
ALTER TABLE fast_push_candidates ADD COLUMN supervisor_candidate_id text;
ALTER TABLE fast_push_candidates ADD COLUMN linked_at integer;

CREATE INDEX IF NOT EXISTS fast_push_candidates_project_item_idx
  ON fast_push_candidates(project_id, project_item_id, project_link_status, status);
CREATE INDEX IF NOT EXISTS fast_push_candidates_supervisor_candidate_idx
  ON fast_push_candidates(supervisor_candidate_id);
