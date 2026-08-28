-- V61.9 — THUMB ingress + package egress 100% LINKS_ONLY.
-- O chat transporta somente IDs/metadados/URLs assinadas; bytes permanecem no R2.

CREATE TABLE IF NOT EXISTS direct_media_uploads (
  upload_token text PRIMARY KEY NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL,
  r2_key text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  metadata_json text NOT NULL DEFAULT '{}',
  production_asset_id text,
  created_at integer NOT NULL,
  expires_at integer NOT NULL,
  confirmed_at integer,
  error text
);
CREATE INDEX IF NOT EXISTS direct_media_uploads_project_idx
  ON direct_media_uploads(project_id, status, created_at);

CREATE TABLE IF NOT EXISTS download_packages (
  id text PRIMARY KEY NOT NULL,
  operation_id text NOT NULL UNIQUE,
  project_id text NOT NULL,
  project_revision integer NOT NULL,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  r2_key text,
  file_name text,
  size_bytes integer NOT NULL DEFAULT 0,
  sha256 text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  ready_at integer,
  downloaded_at integer,
  machine_name text,
  sha256_verified integer,
  download_count integer NOT NULL DEFAULT 0,
  last_link_expires_at integer,
  error text
);
CREATE UNIQUE INDEX IF NOT EXISTS download_packages_revision_idx
  ON download_packages(project_id, project_revision, type);
CREATE INDEX IF NOT EXISTS download_packages_status_idx
  ON download_packages(status, created_at);
