CREATE TABLE IF NOT EXISTS `source_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `status` text DEFAULT 'ATIVO' NOT NULL,
  `type` text DEFAULT 'qualquer' NOT NULL,
  `universes` text DEFAULT '[]' NOT NULL,
  `composition_class` text,
  `semantic_class` text,
  `preferred_hosts` text DEFAULT '[]' NOT NULL,
  `blocked_hosts` text DEFAULT '[]' NOT NULL,
  `preferred_sources` text DEFAULT '[]' NOT NULL,
  `query_template` text,
  `negative_terms` text DEFAULT '[]' NOT NULL,
  `timeout_ms` integer DEFAULT 5000 NOT NULL,
  `max_consecutive_failures` integer DEFAULT 2 NOT NULL,
  `max_urls_per_term` integer DEFAULT 60 NOT NULL,
  `max_sources_per_term` integer DEFAULT 20 NOT NULL,
  `max_rounds` integer DEFAULT 3 NOT NULL,
  `accepted_formats` text DEFAULT '["png","webp","jpg","jpeg"]' NOT NULL,
  `materialization_mode` text DEFAULT 'direta' NOT NULL,
  `allowed_conversions` text DEFAULT '[]' NOT NULL,
  `transparency` text,
  `min_width` integer DEFAULT 64 NOT NULL,
  `min_height` integer DEFAULT 64 NOT NULL,
  `technical_success_rate` integer DEFAULT 0 NOT NULL,
  `visual_approval_rate` integer DEFAULT 0 NOT NULL,
  `avg_time_ms` integer DEFAULT 0 NOT NULL,
  `technical_successes` integer DEFAULT 0 NOT NULL,
  `technical_failures` integer DEFAULT 0 NOT NULL,
  `visual_approvals` integer DEFAULT 0 NOT NULL,
  `visual_rejections` integer DEFAULT 0 NOT NULL,
  `priority` integer DEFAULT 3 NOT NULL,
  `is_default` integer DEFAULT false NOT NULL,
  `notes` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `supervisor_decision_queue` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text REFERENCES `automatic_projects`(`id`),
  `item_id` text REFERENCES `automatic_project_items`(`id`),
  `candidate_id` text,
  `type` text NOT NULL,
  `priority` integer DEFAULT 1 NOT NULL,
  `state` text DEFAULT 'PENDENTE' NOT NULL,
  `evidence` text DEFAULT '{}' NOT NULL,
  `allowed_actions` text DEFAULT '[]' NOT NULL,
  `decision` text,
  `observation` text,
  `source` text DEFAULT 'AUTOMATICO' NOT NULL,
  `resolved_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `supervisor_decision_queue_state_priority_idx` ON `supervisor_decision_queue` (`state`,`priority`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `supervisor_config_events` (
  `id` text PRIMARY KEY NOT NULL,
  `action` text NOT NULL,
  `key` text,
  `previous_value` text,
  `next_value` text,
  `source` text DEFAULT 'SUPERVISOR_MCP' NOT NULL,
  `reason` text,
  `project_id` text,
  `item_id` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `collection_batches` ADD `night_mode` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `collection_sources` ADD `headers_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `collection_sources` ADD `user_agent` text;
--> statement-breakpoint
ALTER TABLE `collection_sources` ADD `timeout_ms` integer DEFAULT 25000 NOT NULL;

--> statement-breakpoint
INSERT OR IGNORE INTO `source_profiles` (`id`,`name`,`status`,`type`,`universes`,`composition_class`,`semantic_class`,`preferred_hosts`,`blocked_hosts`,`preferred_sources`,`query_template`,`negative_terms`,`timeout_ms`,`max_consecutive_failures`,`max_urls_per_term`,`max_sources_per_term`,`max_rounds`,`accepted_formats`,`materialization_mode`,`allowed_conversions`,`transparency`,`min_width`,`min_height`,`technical_success_rate`,`visual_approval_rate`,`avg_time_ms`,`technical_successes`,`technical_failures`,`visual_approvals`,`visual_rejections`,`priority`,`is_default`,`notes`,`created_at`,`updated_at`) VALUES
('SPROF-FANDOM-WIKIA-ANIME','FANDOM_WIKIA_ANIME','ATIVO','isolated','["anime"]','ISOLATED',NULL,'["static.wikia.nocookie.net"]','[]','["Fandom","Wikia"]','{personagem} {universo} full body anime','["manga","monochrome","panel"]',5000,2,60,20,3,'["png","webp","jpg","jpeg"]','direta','["webp->png","jpg->png"]','quando_exigido',64,64,0,0,0,0,0,0,0,1,1,'CDN direto prioritário para personagens isolados; trocar candidata após falha.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
('SPROF-YOUTUBE-CONTEXTUAL','YOUTUBE_CONTEXTUAL','ATIVO','contextual','["anime","cartoon","geek"]','CONTEXTUAL',NULL,'["i.ytimg.com"]','[]','["YouTube"]','{termo} {universo} anime scene','[]',6000,2,40,10,2,'["jpg","webp","png"]','direta','[]','nao',320,180,0,0,0,0,0,0,0,2,0,'Útil para contextual; se frames equivalentes falharem, abandonar a rota.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
('SPROF-ZEROCHAN-ANIME','ZEROCHAN_ANIME','ATIVO','qualquer','["anime","cartoon"]',NULL,NULL,'["zerochan.net"]','[]','["Zerochan"]','{termo} {universo}','["manga","monochrome","watermark"]',6000,2,50,12,3,'["jpg","png","webp"]','direta','[]',NULL,128,128,0,0,0,0,0,0,0,3,0,'Medir aprovação visual; rejeitar fanart, patch e montage incompatíveis.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
('SPROF-PINTEREST-DISCOVERY','PINTEREST_DISCOVERY','ATIVO','qualquer','["anime","cartoon","geek"]',NULL,NULL,'[]','[]','["Pinterest"]','{termo} {universo}','[]',5000,2,30,8,2,'["jpg","png","webp"]','descoberta','[]',NULL,128,128,0,0,0,0,0,0,0,4,0,'Usar como descoberta; reduzir prioridade se materialização/aprovação forem baixas.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000);
--> statement-breakpoint
INSERT OR IGNORE INTO `settings` (`key`,`value`,`updated_at`) VALUES
('supervisor_mcp_enabled','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_default_source_profile','SPROF-FANDOM-WIKIA-ANIME',CAST(strftime('%s','now') AS INTEGER)*1000),
('collection_fetch_timeout_ms','5000',CAST(strftime('%s','now') AS INTEGER)*1000),
('collection_parallelism','3',CAST(strftime('%s','now') AS INTEGER)*1000);
