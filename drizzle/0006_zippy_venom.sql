CREATE TABLE `asset_consultations` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text,
	`concept` text NOT NULL,
	`project` text,
	`query` text,
	`selected` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `semantic_stock_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`concept` text NOT NULL,
	`universe` text DEFAULT 'Sem universo' NOT NULL,
	`kind` text DEFAULT 'Todos' NOT NULL,
	`minimum` integer DEFAULT 3 NOT NULL,
	`ideal` integer DEFAULT 5 NOT NULL,
	`maximum` integer DEFAULT 10 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
