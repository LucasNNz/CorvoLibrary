ALTER TABLE `automatic_projects` ADD `pipeline_status` text DEFAULT 'AGUARDANDO' NOT NULL;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `next_action` text;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `supervisor_execution_id` text;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `supervisor_lease_started_at` integer;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `supervisor_last_seen_at` integer;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `supervisor_lease_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `supervisor_status` text DEFAULT 'LIVRE' NOT NULL;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `previous_execution_id` text;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `abandoned_at` integer;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `resume_reason` text;
--> statement-breakpoint
ALTER TABLE `automatic_projects` ADD `resumed_at` integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `supervisor_executions` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `automatic_projects`(`id`),
  `previous_execution_id` text,
  `status` text DEFAULT 'ATIVO' NOT NULL,
  `lease_started_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL,
  `lease_expires_at` integer NOT NULL,
  `abandoned_at` integer,
  `completed_at` integer,
  `resume_reason` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `supervisor_executions_project_status_idx` ON `supervisor_executions` (`project_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `automatic_projects_supervisor_lease_idx` ON `automatic_projects` (`supervisor_status`,`supervisor_lease_expires_at`,`pipeline_status`);
--> statement-breakpoint
INSERT OR IGNORE INTO `settings` (`key`,`value`,`updated_at`) VALUES
('supervisor_lease_ttl_minutes','10',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_watchdog_interval_minutes','2',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_renew_on_activity','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_auto_mark_abandoned','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_auto_ready_for_resume','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_reconcile_before_resume','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_require_execution_id_for_writes','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_allow_old_execution_writes','false',CAST(strftime('%s','now') AS INTEGER)*1000);
