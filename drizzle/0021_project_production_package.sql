ALTER TABLE automatic_projects ADD COLUMN production_revision integer NOT NULL DEFAULT 1;
ALTER TABLE automatic_projects ADD COLUMN production_zip_revision integer NOT NULL DEFAULT 0;
ALTER TABLE automatic_projects ADD COLUMN production_zip_r2_key text;
ALTER TABLE automatic_projects ADD COLUMN production_zip_file_name text;
ALTER TABLE automatic_projects ADD COLUMN production_zip_size_bytes integer;

CREATE TABLE project_production_assets (
  id text PRIMARY KEY NOT NULL,
  operation_id text NOT NULL UNIQUE,
  project_id text NOT NULL REFERENCES automatic_projects(id),
  kind text NOT NULL DEFAULT 'THUMB',
  name text NOT NULL,
  variant text,
  agent_origin text,
  note text,
  status text NOT NULL DEFAULT 'THUMB_CANDIDATE',
  selected integer NOT NULL DEFAULT 0,
  source_type text NOT NULL DEFAULT 'WEB',
  source_url text,
  r2_key text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL DEFAULT 0,
  sha256 text,
  decision_source text,
  decision_note text,
  decided_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX project_production_assets_project_kind_status_idx ON project_production_assets(project_id, kind, status, created_at);
CREATE INDEX project_production_assets_sha_idx ON project_production_assets(sha256);

CREATE TABLE project_title_candidates (
  id text PRIMARY KEY NOT NULL,
  operation_id text NOT NULL UNIQUE,
  project_id text NOT NULL REFERENCES automatic_projects(id),
  text text NOT NULL,
  variant text,
  agent_origin text,
  note text,
  score integer,
  status text NOT NULL DEFAULT 'TITLE_CANDIDATE',
  selected integer NOT NULL DEFAULT 0,
  decision_source text,
  decision_note text,
  decided_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX project_title_candidates_project_status_idx ON project_title_candidates(project_id, status, created_at);
