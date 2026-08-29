CREATE TABLE `materialization_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`status` text DEFAULT 'BATCH_CREATED' NOT NULL,
	`total_items` integer DEFAULT 0 NOT NULL,
	`completed_items` integer DEFAULT 0 NOT NULL,
	`failed_items` integer DEFAULT 0 NOT NULL,
	`cancelled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `materialization_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`item_db_id` text NOT NULL,
	`priority` integer DEFAULT 1 NOT NULL,
	`source` text,
	`original_url` text NOT NULL,
	`resolved_url` text,
	`host` text,
	`adapter` text DEFAULT 'generic' NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`failure_reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`http_status` integer,
	`content_type` text,
	`content_length` integer,
	`redirects_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `materialization_files` (
	`id` text PRIMARY KEY NOT NULL,
	`item_db_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`sha256` text NOT NULL,
	`technical_status` text NOT NULL,
	`final_asset_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `materialization_host_health` (
	`host` text PRIMARY KEY NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`recent_failure_count` integer DEFAULT 0 NOT NULL,
	`circuit_state` text DEFAULT 'CLOSED' NOT NULL,
	`blocked_until` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `materialization_items` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`item_id` text NOT NULL,
	`target_name` text NOT NULL,
	`concept` text NOT NULL,
	`visual_reference` text,
	`universe` text,
	`preset` text,
	`slot` text,
	`kind` text,
	`subject` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`script_reference` text,
	`used_for` text,
	`min_width` integer DEFAULT 64 NOT NULL,
	`min_height` integer DEFAULT 64 NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`candidate_cursor` integer DEFAULT 0 NOT NULL,
	`selected_candidate_id` text,
	`selected_file_id` text,
	`frozen_asset_id` text,
	`failure_reason` text,
	`route_class` text DEFAULT 'MATERIALIZACAO_DIRETA' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `materialization_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text,
	`item_db_id` text,
	`candidate_id` text,
	`event` text NOT NULL,
	`status` text,
	`detail` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `sha256` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `semantic_family` text;--> statement-breakpoint
INSERT OR IGNORE INTO `settings` (`key`, `value`, `updated_at`) VALUES
  ('MATERIALIZER_V2_ENABLED', 'true', unixepoch() * 1000),
  ('MATERIALIZER_V2_DEFAULT', 'false', unixepoch() * 1000),
  ('MATERIALIZER_V2_CONCURRENCY', '6', unixepoch() * 1000),
  ('MATERIALIZER_V2_PER_HOST', '2', unixepoch() * 1000),
  ('DIRECT_FILE_DELIVERY_ENABLED', 'true', unixepoch() * 1000),
  ('GITHUB_PUBLIC_RESOLVER_ENABLED', 'true', unixepoch() * 1000);
