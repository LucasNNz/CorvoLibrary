CREATE TABLE `asset_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`project` text NOT NULL,
	`block` text,
	`preset` text,
	`slot` text,
	`role` text,
	`script_reference` text,
	`note` text,
	`status` text DEFAULT 'Registrado' NOT NULL,
	`used_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `batch_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`slot` text,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`project` text,
	`status` text DEFAULT 'Rascunho' NOT NULL,
	`manifest_text` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`success` integer DEFAULT true NOT NULL,
	`summary` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `previous_status` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `project_origin` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `script_reference` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `visual_reference` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `operational_note` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `qa_status` text DEFAULT 'NAO_AVALIADO' NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `manifest_text` text;--> statement-breakpoint
ALTER TABLE `imports` ADD `warnings` text DEFAULT '[]' NOT NULL;