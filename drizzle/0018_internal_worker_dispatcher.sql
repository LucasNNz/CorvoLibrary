-- V61: Data Plane interno, dispatcher contínuo e fan-out chunked.
INSERT INTO settings (key, value, updated_at) VALUES ('internal_dispatcher_enabled','true',unixepoch('now')*1000) ON CONFLICT(key) DO NOTHING;
INSERT INTO settings (key, value, updated_at) VALUES ('internal_dispatcher_max_workers','8',unixepoch('now')*1000) ON CONFLICT(key) DO NOTHING;
INSERT INTO settings (key, value, updated_at) VALUES ('internal_dispatcher_max_cycles','3',unixepoch('now')*1000) ON CONFLICT(key) DO NOTHING;
INSERT INTO settings (key, value, updated_at) VALUES ('supervisor_plan_branch_insert_chunk_size','20',unixepoch('now')*1000) ON CONFLICT(key) DO NOTHING;
INSERT INTO settings (key, value, updated_at) VALUES ('supervisor_plan_max_wip','200',unixepoch('now')*1000)
ON CONFLICT(key) DO UPDATE SET value='200', updated_at=excluded.updated_at WHERE settings.value='80';

CREATE INDEX IF NOT EXISTS worker_work_items_dispatch_idx
  ON worker_work_items(status, worker_type, project_domain, priority DESC, resume_priority DESC, original_ready_at, attempts);
CREATE INDEX IF NOT EXISTS worker_work_items_project_dispatch_idx
  ON worker_work_items(project_id, status, stage, priority DESC, original_ready_at);
CREATE INDEX IF NOT EXISTS plan_branches_dispatch_idx
  ON plan_branches(plan_id, status, priority DESC, original_ready_at);
CREATE INDEX IF NOT EXISTS plan_branches_project_item_idx
  ON plan_branches(project_id, item_id, status, stage);
