CREATE TABLE IF NOT EXISTS `supervisor_project_candidates` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `automatic_projects`(`id`),
  `item_id` text NOT NULL REFERENCES `automatic_project_items`(`id`),
  `collection_candidate_id` text,
  `materialization_batch_id` text NOT NULL,
  `materialization_item_id` text NOT NULL,
  `materialization_candidate_id` text,
  `materialization_file_id` text NOT NULL,
  `source` text,
  `original_url` text,
  `host` text,
  `status` text DEFAULT 'PARA_ANALISE' NOT NULL,
  `metadata` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `supervisor_project_candidates_project_item_file_uq` ON `supervisor_project_candidates` (`project_id`,`item_id`,`materialization_file_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `supervisor_project_candidates_project_status_idx` ON `supervisor_project_candidates` (`project_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `supervisor_project_candidates_item_status_idx` ON `supervisor_project_candidates` (`item_id`,`status`,`created_at`);
