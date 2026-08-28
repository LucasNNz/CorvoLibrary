ALTER TABLE `materialization_files` ADD `original_mime_type` text;--> statement-breakpoint
ALTER TABLE `materialization_files` ADD `original_sha256` text;--> statement-breakpoint
ALTER TABLE `materialization_files` ADD `conversion_type` text;--> statement-breakpoint
ALTER TABLE `materialization_items` ADD `requires_alpha` integer DEFAULT false NOT NULL;