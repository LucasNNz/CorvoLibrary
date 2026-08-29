ALTER TABLE `automatic_project_files` ADD `content_hash` text;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `target_file` text;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `composition_class` text DEFAULT 'CONTEXTUAL' NOT NULL;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `semantic_class` text;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `family_id` text;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `family_seed_item_id` text;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `semantic_reference` text;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `search_plan` text;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `strategy_state` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `automatic_project_items` ADD `requirements_hash` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `automatic_project_items_project_version_item_key_idx` ON `automatic_project_items` (`project_id`,`version`,`item_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `automatic_project_items_family_idx` ON `automatic_project_items` (`project_id`,`version`,`family_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `automatic_project_files_hash_uq` ON `automatic_project_files` (`project_id`,`role`,`content_hash`);
--> statement-breakpoint
ALTER TABLE `materialization_items` ADD `composition_class` text DEFAULT 'CONTEXTUAL' NOT NULL;
--> statement-breakpoint
ALTER TABLE `materialization_candidates` ADD `parent_file_id` text;
--> statement-breakpoint
ALTER TABLE `materialization_candidates` ADD `technical_operation` text;
--> statement-breakpoint
ALTER TABLE `materialization_candidates` ADD `technical_parameters` text;
--> statement-breakpoint
ALTER TABLE `materialization_files` ADD `source_file_id` text;
--> statement-breakpoint
ALTER TABLE `materialization_files` ADD `technical_operation` text;
--> statement-breakpoint
ALTER TABLE `materialization_files` ADD `technical_parameters` text;

--> statement-breakpoint
ALTER TABLE `collection_terms` ADD `source_plan` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `materialization_host_probes` (
  `id` text PRIMARY KEY NOT NULL,
  `url_hash` text NOT NULL,
  `url` text NOT NULL,
  `host` text NOT NULL,
  `status` text NOT NULL,
  `http_status` integer,
  `content_type` text,
  `detail` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `materialization_host_probes_url_time_idx` ON `materialization_host_probes` (`url_hash`,`created_at`);
