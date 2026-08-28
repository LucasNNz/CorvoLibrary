ALTER TABLE `automatic_projects` ADD `project_domain` text DEFAULT 'GENERAL' NOT NULL;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `queue_priority` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `ready_at` integer;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `original_ready_at` integer;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `last_action` text;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `item_domain` text;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `stage` text;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `stage_ready_at` integer;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `original_ready_at` integer;
--> statement-breakpoint
ALTER TABLE `source_profiles` ADD `domain` text DEFAULT 'GENERAL' NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `worker_capacity_limits` (
  `id` text PRIMARY KEY NOT NULL,
  `worker_type` text NOT NULL,
  `worker_domain` text DEFAULT '*' NOT NULL,
  `max_workers` integer DEFAULT 3 NOT NULL,
  `max_per_project` integer DEFAULT 3 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `worker_capacity_type_domain_idx` ON `worker_capacity_limits` (`worker_type`,`worker_domain`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `worker_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `worker_id` text NOT NULL,
  `worker_type` text NOT NULL,
  `worker_domain` text NOT NULL,
  `allowed_domains` text DEFAULT '[]' NOT NULL,
  `execution_id` text NOT NULL,
  `status` text DEFAULT 'ATIVO' NOT NULL,
  `current_work_item_id` text,
  `project_id` text REFERENCES `automatic_projects`(`id`),
  `stage` text,
  `last_action` text,
  `started_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL,
  `stopped_at` integer,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `worker_sessions_execution_idx` ON `worker_sessions` (`execution_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worker_sessions_active_idx` ON `worker_sessions` (`status`,`worker_type`,`worker_domain`,`last_seen_at`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `worker_work_items` (
  `id` text PRIMARY KEY NOT NULL,
  `scope_type` text NOT NULL,
  `scope_id` text NOT NULL,
  `project_id` text NOT NULL REFERENCES `automatic_projects`(`id`),
  `project_domain` text DEFAULT 'GENERAL' NOT NULL,
  `item_id` text REFERENCES `automatic_project_items`(`id`),
  `stage` text NOT NULL,
  `worker_type` text NOT NULL,
  `priority` integer DEFAULT 1 NOT NULL,
  `resume_priority` integer DEFAULT 0 NOT NULL,
  `status` text DEFAULT 'READY' NOT NULL,
  `ready_at` integer NOT NULL,
  `original_ready_at` integer NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `lease_owner_worker_id` text,
  `lease_execution_id` text,
  `lease_started_at` integer,
  `lease_last_seen_at` integer,
  `lease_expires_at` integer,
  `last_action` text,
  `payload_json` text DEFAULT '{}' NOT NULL,
  `completed_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `worker_work_scope_stage_idx` ON `worker_work_items` (`scope_type`,`scope_id`,`stage`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worker_work_fifo_idx` ON `worker_work_items` (`worker_type`,`project_domain`,`status`,`priority`,`resume_priority`,`original_ready_at`,`ready_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worker_work_lease_idx` ON `worker_work_items` (`status`,`lease_expires_at`,`lease_owner_worker_id`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `worker_events` (
  `id` text PRIMARY KEY NOT NULL,
  `worker_id` text,
  `worker_type` text,
  `worker_domain` text,
  `execution_id` text,
  `project_id` text REFERENCES `automatic_projects`(`id`),
  `work_item_id` text,
  `stage` text,
  `event_type` text NOT NULL,
  `status` text,
  `duration_ms` integer,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worker_events_time_idx` ON `worker_events` (`created_at`,`event_type`,`worker_type`,`worker_domain`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worker_events_project_idx` ON `worker_events` (`project_id`,`stage`,`created_at`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `stage_metrics` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `automatic_projects`(`id`),
  `project_domain` text DEFAULT 'GENERAL' NOT NULL,
  `worker_id` text,
  `worker_type` text,
  `work_item_id` text,
  `stage` text NOT NULL,
  `result` text NOT NULL,
  `duration_ms` integer DEFAULT 0 NOT NULL,
  `queue_wait_ms` integer DEFAULT 0 NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `started_at` integer,
  `completed_at` integer NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stage_metrics_stage_time_idx` ON `stage_metrics` (`stage`,`project_domain`,`completed_at`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `queue_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `stage` text NOT NULL,
  `project_domain` text NOT NULL,
  `ready_count` integer DEFAULT 0 NOT NULL,
  `leased_count` integer DEFAULT 0 NOT NULL,
  `waiting_count` integer DEFAULT 0 NOT NULL,
  `captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `queue_snapshots_time_idx` ON `queue_snapshots` (`captured_at`,`stage`,`project_domain`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `project_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `automatic_projects`(`id`),
  `project_domain` text DEFAULT 'GENERAL' NOT NULL,
  `status` text DEFAULT 'ATIVO' NOT NULL,
  `started_at` integer NOT NULL,
  `completed_at` integer,
  `total_duration_ms` integer,
  `retries` integer DEFAULT 0 NOT NULL,
  `relinks` integer DEFAULT 0 NOT NULL,
  `resumes` integer DEFAULT 0 NOT NULL,
  `workers_involved` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `project_runs_project_idx` ON `project_runs` (`project_id`,`status`,`updated_at`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `export_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `automatic_projects`(`id`),
  `project_domain` text DEFAULT 'GENERAL' NOT NULL,
  `status` text DEFAULT 'READY' NOT NULL,
  `asset_set_hash` text,
  `r2_key` text,
  `file_name` text,
  `size_bytes` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `export_jobs_status_idx` ON `export_jobs` (`status`,`project_domain`,`created_at`);
--> statement-breakpoint

INSERT OR IGNORE INTO `worker_capacity_limits` (`id`,`worker_type`,`worker_domain`,`max_workers`,`max_per_project`,`enabled`,`updated_at`) VALUES
('LIMIT-SCRIPT-*','SCRIPT','*',3,1,1,CAST(strftime('%s','now') AS INTEGER)*1000),
('LIMIT-COLLECTOR-*','COLLECTOR','*',3,3,1,CAST(strftime('%s','now') AS INTEGER)*1000),
('LIMIT-MATERIALIZER-*','MATERIALIZER','*',5,5,1,CAST(strftime('%s','now') AS INTEGER)*1000),
('LIMIT-ANALYST-*','ANALYST','*',3,3,1,CAST(strftime('%s','now') AS INTEGER)*1000),
('LIMIT-QA-*','QA','*',3,3,1,CAST(strftime('%s','now') AS INTEGER)*1000),
('LIMIT-RELINK-*','RELINK','*',3,3,1,CAST(strftime('%s','now') AS INTEGER)*1000),
('LIMIT-TECHNICAL_FIX-*','TECHNICAL_FIX','*',3,3,1,CAST(strftime('%s','now') AS INTEGER)*1000),
('LIMIT-ORGANIZER-*','ORGANIZER','*',3,1,1,CAST(strftime('%s','now') AS INTEGER)*1000),
('LIMIT-EXPORTER-*','EXPORTER','*',3,1,1,CAST(strftime('%s','now') AS INTEGER)*1000),
('LIMIT-ZIP-*','ZIP','*',3,1,1,CAST(strftime('%s','now') AS INTEGER)*1000),
('LIMIT-SUPERVISOR-*','SUPERVISOR','*',3,3,1,CAST(strftime('%s','now') AS INTEGER)*1000);
--> statement-breakpoint

INSERT OR IGNORE INTO `settings` (`key`,`value`,`updated_at`) VALUES
('worker_watchdog_interval_minutes','2',CAST(strftime('%s','now') AS INTEGER)*1000),
('worker_lease_ttl_minutes','10',CAST(strftime('%s','now') AS INTEGER)*1000),
('fifo_enabled','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('skip_locked','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('lease_granular','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('requeue_expired_lease','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('preserve_original_queue_age','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('fallback_between_domains','false',CAST(strftime('%s','now') AS INTEGER)*1000);
--> statement-breakpoint

UPDATE `automatic_projects` SET `ready_at`=COALESCE(`ready_at`,`created_at`), `original_ready_at`=COALESCE(`original_ready_at`,`created_at`), `project_domain`=COALESCE(NULLIF(`project_domain`,''),'GENERAL');
--> statement-breakpoint
UPDATE `automatic_project_items` SET `item_domain`=COALESCE(`item_domain`,(SELECT `project_domain` FROM `automatic_projects` p WHERE p.id=`automatic_project_items`.`project_id`),'GENERAL'), `stage_ready_at`=COALESCE(`stage_ready_at`,`updated_at`), `original_ready_at`=COALESCE(`original_ready_at`,`created_at`);
