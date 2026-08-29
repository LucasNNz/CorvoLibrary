-- Corvo Library — schema SQLite reconstruído das migrations aplicadas ao D1 vivo

-- Exportado em 2026-08-28T23:21:31.254Z

PRAGMA foreign_keys=OFF;

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

CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`universe` text DEFAULT 'Sem universo' NOT NULL,
	`kind` text DEFAULT 'Imagem' NOT NULL,
	`status` text DEFAULT 'Pendente' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`r2_key` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
, `subject` text, `previous_status` text, `project_origin` text, `script_reference` text, `visual_reference` text, `source_url` text, `operational_note` text, `qa_status` text DEFAULT 'NAO_AVALIADO' NOT NULL, `sha256` text, `semantic_family` text);

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

CREATE TABLE `automatic_project_files` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`role` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`file_name` text NOT NULL,
	`r2_key` text NOT NULL,
	`mime_type` text DEFAULT 'text/plain' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL, `content_hash` text,
	FOREIGN KEY (`project_id`) REFERENCES `automatic_projects`(`id`) ON UPDATE no action ON DELETE no action
);

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
	`updated_at` integer NOT NULL, `target_file` text, `composition_class` text DEFAULT 'CONTEXTUAL' NOT NULL, `semantic_class` text, `family_id` text, `family_seed_item_id` text, `semantic_reference` text, `search_plan` text, `strategy_state` text DEFAULT '{}' NOT NULL, `requirements_hash` text, `item_domain` text, `stage` text, `stage_ready_at` integer, `original_ready_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `automatic_projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);

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
, `pipeline_status` text DEFAULT 'AGUARDANDO' NOT NULL, `next_action` text, `supervisor_execution_id` text, `supervisor_lease_started_at` integer, `supervisor_last_seen_at` integer, `supervisor_lease_expires_at` integer, `supervisor_status` text DEFAULT 'LIVRE' NOT NULL, `previous_execution_id` text, `abandoned_at` integer, `resume_reason` text, `resumed_at` integer, `project_domain` text DEFAULT 'GENERAL' NOT NULL, `queue_priority` integer DEFAULT 1 NOT NULL, `ready_at` integer, `original_ready_at` integer, `last_action` text, state_version integer NOT NULL DEFAULT 1, total_items integer NOT NULL DEFAULT 0, approved_count integer NOT NULL DEFAULT 0, frozen_count integer NOT NULL DEFAULT 0, collecting_count integer NOT NULL DEFAULT 0, materializing_count integer NOT NULL DEFAULT 0, waiting_qa_count integer NOT NULL DEFAULT 0, relink_count integer NOT NULL DEFAULT 0, technical_count integer NOT NULL DEFAULT 0, waiting_seed_count integer NOT NULL DEFAULT 0, failed_count integer NOT NULL DEFAULT 0, pending_count integer NOT NULL DEFAULT 0, last_frozen_at integer, active_plan_id TEXT);

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

CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`project` text,
	`status` text DEFAULT 'Rascunho' NOT NULL,
	`manifest_text` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

CREATE TABLE `collection_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'CRIADO' NOT NULL,
	`terms_text` text NOT NULL,
	`max_urls_per_term` integer DEFAULT 100 NOT NULL,
	`max_sources_per_term` integer DEFAULT 20 NOT NULL,
	`max_rounds_per_term` integer DEFAULT 5 NOT NULL,
	`max_term_minutes` integer DEFAULT 45 NOT NULL,
	`max_total_minutes` integer DEFAULT 480 NOT NULL,
	`total_terms` integer DEFAULT 0 NOT NULL,
	`total_target` integer DEFAULT 0 NOT NULL,
	`total_collected` integer DEFAULT 0 NOT NULL,
	`report_text` text,
	`cancelled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL
, `night_mode` integer DEFAULT true NOT NULL);

CREATE TABLE `collection_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`term_id` text NOT NULL,
	`source_id` text NOT NULL,
	`url` text NOT NULL,
	`normalized_url` text NOT NULL,
	`thumbnail` text,
	`estimated_type` text,
	`priority` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'CANDIDATA' NOT NULL,
	`failure_reason` text,
	`sha256` text,
	`materialization_batch_id` text,
	`materialization_item_id` text,
	`materialization_file_id` text,
	`asset_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `collection_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`term_id`) REFERENCES `collection_terms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `collection_sources`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `collection_source_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`term_id` text NOT NULL,
	`source_id` text NOT NULL,
	`found_count` integer DEFAULT 0 NOT NULL,
	`unique_count` integer DEFAULT 0 NOT NULL,
	`materialized_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL
);

CREATE TABLE `collection_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`query_param` text DEFAULT 'q' NOT NULL,
	`limit_param` text DEFAULT 'limit' NOT NULL,
	`image_path` text NOT NULL,
	`thumbnail_path` text,
	`priority` integer DEFAULT 3 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`api_key_env` text,
	`api_key_header` text,
	`note` text,
	`query_count` integer DEFAULT 0 NOT NULL,
	`found_count` integer DEFAULT 0 NOT NULL,
	`unique_count` integer DEFAULT 0 NOT NULL,
	`materialized_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`total_duration_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
, `headers_json` text DEFAULT '{}' NOT NULL, `user_agent` text, `timeout_ms` integer DEFAULT 25000 NOT NULL, domain TEXT NOT NULL DEFAULT 'MULTI', supported_universes TEXT NOT NULL DEFAULT '[]', supported_composition_classes TEXT NOT NULL DEFAULT '["CONTEXTUAL","ISOLATED"]', can_discover INTEGER NOT NULL DEFAULT 1, can_materialize INTEGER NOT NULL DEFAULT 1, requires_external_search INTEGER NOT NULL DEFAULT 0, configured INTEGER NOT NULL DEFAULT 1, capability_version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE `collection_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`term` text NOT NULL,
	`target_quantity` integer NOT NULL,
	`kind` text DEFAULT 'qualquer' NOT NULL,
	`universe` text,
	`status` text DEFAULT 'PENDENTE' NOT NULL,
	`collected_count` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`rounds` integer DEFAULT 0 NOT NULL,
	`source_cursor` integer DEFAULT 0 NOT NULL,
	`failure_reason` text,
	`started_at` integer,
	`updated_at` integer NOT NULL, `source_plan` text,
	FOREIGN KEY (`batch_id`) REFERENCES `collection_batches`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `export_jobs` (
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

CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`r2_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text DEFAULT 'Recebido' NOT NULL,
	`created_at` integer NOT NULL
, `manifest_text` text, `warnings` text DEFAULT '[]' NOT NULL);

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
, `parent_file_id` text, `technical_operation` text, `technical_parameters` text);

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
, `original_mime_type` text, `original_sha256` text, `conversion_type` text, `source_file_id` text, `technical_operation` text, `technical_parameters` text);

CREATE TABLE `materialization_host_health` (
	`host` text PRIMARY KEY NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`recent_failure_count` integer DEFAULT 0 NOT NULL,
	`circuit_state` text DEFAULT 'CLOSED' NOT NULL,
	`blocked_until` integer,
	`updated_at` integer NOT NULL
);

CREATE TABLE `materialization_host_probes` (
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
, `requires_alpha` integer DEFAULT false NOT NULL, `composition_class` text DEFAULT 'CONTEXTUAL' NOT NULL);

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

CREATE TABLE `mcp_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`success` integer DEFAULT true NOT NULL,
	`summary` text,
	`created_at` integer NOT NULL
, request_id text, started_at integer, finished_at integer, duration_ms integer, auth_ms integer NOT NULL DEFAULT 0, parse_ms integer NOT NULL DEFAULT 0, db_ms integer NOT NULL DEFAULT 0, db_query_count integer NOT NULL DEFAULT 0, r2_ms integer NOT NULL DEFAULT 0, r2_request_count integer NOT NULL DEFAULT 0, external_http_ms integer NOT NULL DEFAULT 0, external_http_count integer NOT NULL DEFAULT 0, serialization_ms integer NOT NULL DEFAULT 0, queue_ms integer NOT NULL DEFAULT 0, response_bytes integer NOT NULL DEFAULT 0, rows_read integer NOT NULL DEFAULT 0, rows_written integer NOT NULL DEFAULT 0, cache_hit integer NOT NULL DEFAULT 0, cold_start integer NOT NULL DEFAULT 0);

CREATE TABLE operation_results (
  operation_id text PRIMARY KEY NOT NULL,
  tool text NOT NULL,
  project_id text,
  status text NOT NULL DEFAULT 'RUNNING',
  result_json text,
  error text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE TABLE operational_gaps (
  id TEXT PRIMARY KEY NOT NULL,
  signature TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'MEDIUM',
  project_id TEXT REFERENCES automatic_projects(id),
  item_id TEXT REFERENCES automatic_project_items(id),
  domain TEXT,
  universe TEXT,
  composition_class TEXT,
  semantic_class TEXT,
  preset TEXT,
  source TEXT,
  host TEXT,
  tool TEXT,
  worker_type TEXT,
  symptom TEXT NOT NULL,
  root_cause TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolution_policy_id TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE operational_policies (
  id TEXT PRIMARY KEY NOT NULL,
  policy_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  rule_type TEXT NOT NULL DEFAULT 'LEARNED_POLICY',
  scope_level TEXT NOT NULL DEFAULT 'PROJECT',
  propagation_level INTEGER NOT NULL DEFAULT 1,
  domain TEXT,
  universe TEXT,
  work_type TEXT,
  composition_class TEXT,
  semantic_class TEXT,
  preset TEXT,
  project_id TEXT REFERENCES automatic_projects(id),
  item_id TEXT REFERENCES automatic_project_items(id),
  condition_json TEXT NOT NULL DEFAULT '{}',
  action_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 1,
  confidence INTEGER NOT NULL DEFAULT 50,
  source_gap_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'SUPERVISOR_MCP',
  version INTEGER NOT NULL DEFAULT 1,
  previous_version_id TEXT,
  rollback_to_version INTEGER,
  times_matched INTEGER NOT NULL DEFAULT 0,
  times_applied INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  avg_time_before_ms INTEGER NOT NULL DEFAULT 0,
  avg_time_after_ms INTEGER NOT NULL DEFAULT 0,
  approval_rate_before INTEGER NOT NULL DEFAULT 0,
  approval_rate_after INTEGER NOT NULL DEFAULT 0,
  cost_before INTEGER NOT NULL DEFAULT 0,
  cost_after INTEGER NOT NULL DEFAULT 0,
  last_applied_at INTEGER,
  last_result TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE operational_policy_events (
  id TEXT PRIMARY KEY NOT NULL,
  policy_id TEXT REFERENCES operational_policies(id),
  policy_version INTEGER,
  gap_id TEXT REFERENCES operational_gaps(id),
  project_id TEXT REFERENCES automatic_projects(id),
  item_id TEXT REFERENCES automatic_project_items(id),
  event_type TEXT NOT NULL,
  before_state_json TEXT NOT NULL DEFAULT '{}',
  after_state_json TEXT NOT NULL DEFAULT '{}',
  action_json TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  time_saved_ms INTEGER NOT NULL DEFAULT 0,
  requests_saved INTEGER NOT NULL DEFAULT 0,
  external_requests_saved INTEGER NOT NULL DEFAULT 0,
  false_positive INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE plan_branches (
  id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL REFERENCES supervisor_plans(id),
  project_id TEXT NOT NULL REFERENCES automatic_projects(id),
  item_id TEXT REFERENCES automatic_project_items(id),
  stage TEXT NOT NULL,
  branch_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'READY',
  ready_at INTEGER NOT NULL,
  original_ready_at INTEGER NOT NULL,
  worker_type TEXT,
  worker_domain TEXT NOT NULL DEFAULT 'GENERAL',
  lease_owner TEXT,
  lease_execution_id TEXT,
  lease_expires_at INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  parent_branch_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE `project_runs` (
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

CREATE TABLE `queue_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `stage` text NOT NULL,
  `project_domain` text NOT NULL,
  `ready_count` integer DEFAULT 0 NOT NULL,
  `leased_count` integer DEFAULT 0 NOT NULL,
  `waiting_count` integer DEFAULT 0 NOT NULL,
  `captured_at` integer NOT NULL
);

CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`raw_items` text NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'Validando' NOT NULL,
	`created_at` integer NOT NULL
);

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

CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);

CREATE TABLE `source_profiles` (
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
, `domain` text DEFAULT 'GENERAL' NOT NULL);

CREATE TABLE source_route_metrics (
  id text PRIMARY KEY NOT NULL,
  universe text NOT NULL DEFAULT '*',
  composition_class text NOT NULL DEFAULT '*',
  source_id text,
  source_name text NOT NULL,
  host text NOT NULL DEFAULT '*',
  attempts integer NOT NULL DEFAULT 0,
  materialized integer NOT NULL DEFAULT 0,
  approved integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  technical_failures integer NOT NULL DEFAULT 0,
  semantic_failures integer NOT NULL DEFAULT 0,
  total_duration_ms integer NOT NULL DEFAULT 0,
  score integer NOT NULL DEFAULT 0,
  updated_at integer NOT NULL
);

CREATE TABLE source_routing_plans (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT REFERENCES automatic_projects(id),
  item_id TEXT REFERENCES automatic_project_items(id),
  collection_term_id TEXT,
  project_domain TEXT NOT NULL DEFAULT 'GENERAL',
  universe TEXT,
  composition_class TEXT,
  target_type TEXT,
  canonical_reference TEXT,
  eligible_sources_json TEXT NOT NULL DEFAULT '[]',
  excluded_sources_json TEXT NOT NULL DEFAULT '[]',
  discovery_sources_json TEXT NOT NULL DEFAULT '[]',
  materialization_sources_json TEXT NOT NULL DEFAULT '[]',
  fallback_sources_json TEXT NOT NULL DEFAULT '[]',
  routing_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE `stage_metrics` (
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

CREATE TABLE `supervisor_config_events` (
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

CREATE TABLE `supervisor_decision_queue` (
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

CREATE TABLE `supervisor_executions` (
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

CREATE TABLE supervisor_plans (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES automatic_projects(id),
  execution_id TEXT,
  operation_id TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'ACCEPTED',
  priority INTEGER NOT NULL DEFAULT 1,
  intent TEXT NOT NULL DEFAULT 'EXECUTE_UNTIL_DIVERGENCE',
  scope_json TEXT NOT NULL DEFAULT '{}',
  max_parallelism INTEGER NOT NULL DEFAULT 8,
  stop_conditions_json TEXT NOT NULL DEFAULT '[]',
  success_conditions_json TEXT NOT NULL DEFAULT '[]',
  fallback_policy_json TEXT NOT NULL DEFAULT '{}',
  source_policy_json TEXT NOT NULL DEFAULT '{}',
  qa_policy_json TEXT NOT NULL DEFAULT '{}',
  relink_policy_json TEXT NOT NULL DEFAULT '{}',
  technical_policy_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  result_summary_json TEXT NOT NULL DEFAULT '{}',
  project_version_at_creation INTEGER NOT NULL DEFAULT 1,
  policy_version TEXT NOT NULL DEFAULT 'V60',
  accepted_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE `supervisor_project_candidates` (
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

CREATE TABLE `worker_capacity_limits` (
  `id` text PRIMARY KEY NOT NULL,
  `worker_type` text NOT NULL,
  `worker_domain` text DEFAULT '*' NOT NULL,
  `max_workers` integer DEFAULT 3 NOT NULL,
  `max_per_project` integer DEFAULT 3 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `updated_at` integer NOT NULL
);

CREATE TABLE `worker_events` (
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

CREATE TABLE `worker_sessions` (
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

CREATE TABLE `worker_work_items` (
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

CREATE UNIQUE INDEX `automatic_project_files_hash_uq` ON `automatic_project_files` (`project_id`,`role`,`content_hash`);

CREATE INDEX `automatic_project_items_family_idx` ON `automatic_project_items` (`project_id`,`version`,`family_id`);

CREATE INDEX `automatic_project_items_project_version_item_key_idx` ON `automatic_project_items` (`project_id`,`version`,`item_key`);

CREATE INDEX `automatic_projects_supervisor_lease_idx` ON `automatic_projects` (`supervisor_status`,`supervisor_lease_expires_at`,`pipeline_status`);

CREATE INDEX `export_jobs_status_idx` ON `export_jobs` (`status`,`project_domain`,`created_at`);

CREATE INDEX idx_assets_semantic_qa ON assets(semantic_family, qa_status);

CREATE INDEX idx_assets_status_updated ON assets(status, updated_at, id);

CREATE INDEX idx_assets_universe_kind_qa ON assets(universe, kind, qa_status);

CREATE INDEX idx_collection_candidates_batch_status_created ON collection_candidates(batch_id, status, created_at);

CREATE INDEX idx_collection_candidates_term_status_created ON collection_candidates(term_id, status, created_at);

CREATE INDEX idx_collection_runs_term_created ON collection_source_runs(term_id, created_at);

CREATE INDEX idx_collection_sources_routing
  ON collection_sources(active, configured, domain, can_discover, priority);

CREATE INDEX idx_collection_terms_batch_status ON collection_terms(batch_id, status, updated_at);

CREATE INDEX idx_materialization_candidates_item_status_priority ON materialization_candidates(item_db_id, status, priority, created_at);

CREATE INDEX idx_materialization_files_item_created ON materialization_files(item_db_id, created_at);

CREATE INDEX idx_materialization_items_batch_status ON materialization_items(batch_id, status, updated_at);

CREATE INDEX idx_mcp_audit_duration ON mcp_audit(duration_ms, created_at);

CREATE INDEX idx_mcp_audit_tool_created ON mcp_audit(tool, created_at);

CREATE INDEX idx_operation_results_project_tool_updated
  ON operation_results(project_id, tool, updated_at DESC);

CREATE INDEX idx_operation_results_project_updated ON operation_results(project_id, updated_at);

CREATE INDEX idx_operational_gaps_project_item ON operational_gaps(project_id, item_id, last_seen_at DESC);

CREATE UNIQUE INDEX idx_operational_gaps_signature ON operational_gaps(signature);

CREATE INDEX idx_operational_gaps_status_occurrence ON operational_gaps(status, occurrence_count DESC, last_seen_at DESC);

CREATE INDEX idx_operational_policies_key_version ON operational_policies(policy_key, version DESC);

CREATE INDEX idx_operational_policies_project_item ON operational_policies(project_id, item_id, status, priority DESC);

CREATE INDEX idx_operational_policies_status_scope_domain ON operational_policies(status, scope_level, domain, priority DESC);

CREATE INDEX idx_operational_policies_universe_composition ON operational_policies(universe, composition_class, status, priority DESC);

CREATE INDEX idx_operational_policy_events_policy_time ON operational_policy_events(policy_id, created_at DESC);

CREATE INDEX idx_operational_policy_events_project_time ON operational_policy_events(project_id, created_at DESC);

CREATE UNIQUE INDEX idx_plan_branches_idempotency
  ON plan_branches(idempotency_key);

CREATE INDEX idx_plan_branches_plan_status_ready
  ON plan_branches(plan_id, status, priority DESC, original_ready_at ASC);

CREATE INDEX idx_plan_branches_project_item_status
  ON plan_branches(project_id, item_id, status);

CREATE INDEX idx_project_items_project_status_priority ON automatic_project_items(project_id, status, priority, created_at);

CREATE INDEX idx_project_items_project_target ON automatic_project_items(project_id, target_file);

CREATE INDEX idx_project_items_project_updated ON automatic_project_items(project_id, updated_at, id);

CREATE INDEX idx_project_items_status_stage_ready ON automatic_project_items(status, stage_ready_at, priority, id);

CREATE INDEX idx_projects_pipeline_version ON automatic_projects(pipeline_status, state_version, updated_at);

CREATE INDEX idx_projects_status_domain_ready ON automatic_projects(status, project_domain, ready_at, created_at);

CREATE UNIQUE INDEX idx_source_route_metric_unique ON source_route_metrics(universe, composition_class, source_name, host);

CREATE INDEX idx_source_route_score ON source_route_metrics(universe, composition_class, score, updated_at);

CREATE INDEX idx_source_routing_plans_item_updated
  ON source_routing_plans(project_id, item_id, updated_at DESC);

CREATE INDEX idx_supervisor_candidates_item_status_created ON supervisor_project_candidates(item_id, status, created_at);

CREATE INDEX idx_supervisor_candidates_project_status_created ON supervisor_project_candidates(project_id, status, created_at);

CREATE INDEX idx_supervisor_decisions_project_state_priority ON supervisor_decision_queue(project_id, state, priority, created_at);

CREATE UNIQUE INDEX idx_supervisor_plans_operation
  ON supervisor_plans(operation_id) WHERE operation_id IS NOT NULL;

CREATE INDEX idx_supervisor_plans_project_status_updated
  ON supervisor_plans(project_id, status, updated_at DESC);

CREATE INDEX idx_worker_events_project_created ON worker_events(project_id, created_at, id);

CREATE INDEX idx_worker_events_type_created ON worker_events(event_type, created_at, id);

CREATE INDEX idx_worker_items_lease_expiry ON worker_work_items(status, lease_expires_at);

CREATE INDEX idx_worker_items_queue_fifo ON worker_work_items(stage, project_domain, status, priority DESC, resume_priority DESC, original_ready_at ASC, attempts ASC, id ASC);

CREATE INDEX idx_worker_sessions_active_type_domain ON worker_sessions(status, worker_type, worker_domain, updated_at);

CREATE INDEX `materialization_host_probes_url_time_idx` ON `materialization_host_probes` (`url_hash`,`created_at`);

CREATE INDEX `project_runs_project_idx` ON `project_runs` (`project_id`,`status`,`updated_at`);

CREATE INDEX `queue_snapshots_time_idx` ON `queue_snapshots` (`captured_at`,`stage`,`project_domain`);

CREATE INDEX `stage_metrics_stage_time_idx` ON `stage_metrics` (`stage`,`project_domain`,`completed_at`);

CREATE INDEX `supervisor_decision_queue_state_priority_idx` ON `supervisor_decision_queue` (`state`,`priority`,`created_at`);

CREATE INDEX `supervisor_executions_project_status_idx` ON `supervisor_executions` (`project_id`,`status`,`updated_at`);

CREATE INDEX `supervisor_project_candidates_item_status_idx` ON `supervisor_project_candidates` (`item_id`,`status`,`created_at`);

CREATE UNIQUE INDEX `supervisor_project_candidates_project_item_file_uq` ON `supervisor_project_candidates` (`project_id`,`item_id`,`materialization_file_id`);

CREATE INDEX `supervisor_project_candidates_project_status_idx` ON `supervisor_project_candidates` (`project_id`,`status`,`created_at`);

CREATE UNIQUE INDEX `worker_capacity_type_domain_idx` ON `worker_capacity_limits` (`worker_type`,`worker_domain`);

CREATE INDEX `worker_events_project_idx` ON `worker_events` (`project_id`,`stage`,`created_at`);

CREATE INDEX `worker_events_time_idx` ON `worker_events` (`created_at`,`event_type`,`worker_type`,`worker_domain`);

CREATE INDEX `worker_sessions_active_idx` ON `worker_sessions` (`status`,`worker_type`,`worker_domain`,`last_seen_at`);

CREATE UNIQUE INDEX `worker_sessions_execution_idx` ON `worker_sessions` (`execution_id`);

CREATE INDEX `worker_work_fifo_idx` ON `worker_work_items` (`worker_type`,`project_domain`,`status`,`priority`,`resume_priority`,`original_ready_at`,`ready_at`);

CREATE INDEX `worker_work_lease_idx` ON `worker_work_items` (`status`,`lease_expires_at`,`lease_owner_worker_id`);

CREATE UNIQUE INDEX `worker_work_scope_stage_idx` ON `worker_work_items` (`scope_type`,`scope_id`,`stage`);

PRAGMA foreign_keys=ON;

