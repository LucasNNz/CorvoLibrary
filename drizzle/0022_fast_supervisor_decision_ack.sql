-- V61.6 — FAST ACK para decisões do Supervisor.
-- A decisão é persistida primeiro; congelamento/catalogação/fan-out continua no Data Plane.

CREATE TABLE supervisor_decision_jobs (
  id text PRIMARY KEY NOT NULL,
  operation_id text NOT NULL UNIQUE,
  project_id text NOT NULL REFERENCES automatic_projects(id),
  kind text NOT NULL DEFAULT 'PROJECT_QA',
  status text NOT NULL DEFAULT 'QUEUED',
  payload_json text NOT NULL,
  progress_json text NOT NULL DEFAULT '{}',
  result_json text,
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at integer,
  started_at integer,
  completed_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE INDEX idx_supervisor_decision_jobs_status_created
  ON supervisor_decision_jobs(status, created_at);
CREATE INDEX idx_supervisor_decision_jobs_project_status
  ON supervisor_decision_jobs(project_id, status, updated_at);
CREATE INDEX idx_supervisor_decision_jobs_lease
  ON supervisor_decision_jobs(status, lease_expires_at);
