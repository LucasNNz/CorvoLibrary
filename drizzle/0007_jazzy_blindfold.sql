CREATE TABLE `automatic_project_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`item_id` text,
	`event` text NOT NULL,
	`status` text,
	`detail` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `automatic_projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `automatic_project_files` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`role` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`file_name` text NOT NULL,
	`r2_key` text NOT NULL,
	`mime_type` text DEFAULT 'text/plain' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `automatic_projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `automatic_project_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`item_key` text NOT NULL,
	`term` text NOT NULL,
	`context` text,
	`kind` text DEFAULT 'contextual' NOT NULL,
	`universe` text,
	`notes` text,
	`status` text DEFAULT 'PARSING' NOT NULL,
	`priority` integer DEFAULT 1 NOT NULL,
	`source_type` text,
	`linked_asset_id` text,
	`collection_term_id` text,
	`collection_candidate_id` text,
	`materialization_batch_id` text,
	`materialization_item_id` text,
	`materialization_file_id` text,
	`failure_reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `automatic_projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `automatic_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'WAITING_FILES' NOT NULL,
	`automatic` integer DEFAULT true NOT NULL,
	`library_first` integer DEFAULT true NOT NULL,
	`external_search` integer DEFAULT true NOT NULL,
	`parallel_materialization` integer DEFAULT true NOT NULL,
	`automatic_technical_qa` integer DEFAULT true NOT NULL,
	`automatic_zip` integer DEFAULT true NOT NULL,
	`delete_zip_on_complete` integer DEFAULT true NOT NULL,
	`circuit_breaker` integer DEFAULT true NOT NULL,
	`active_version` integer DEFAULT 1 NOT NULL,
	`collection_batch_id` text,
	`zip_r2_key` text,
	`zip_file_name` text,
	`zip_size_bytes` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
