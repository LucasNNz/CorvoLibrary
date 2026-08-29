-- V60 — SUPERVISOR PLAN + FAN-OUT/FAN-IN + EXECUTION UNTIL DIVERGENCE
-- Evolução aditiva sobre V59. Não remove assets, projetos, filas ou histórico.

ALTER TABLE automatic_projects ADD COLUMN active_plan_id TEXT;

ALTER TABLE collection_sources ADD COLUMN domain TEXT NOT NULL DEFAULT 'MULTI';
ALTER TABLE collection_sources ADD COLUMN supported_universes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE collection_sources ADD COLUMN supported_composition_classes TEXT NOT NULL DEFAULT '["CONTEXTUAL","ISOLATED"]';
ALTER TABLE collection_sources ADD COLUMN can_discover INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collection_sources ADD COLUMN can_materialize INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collection_sources ADD COLUMN requires_external_search INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_sources ADD COLUMN configured INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collection_sources ADD COLUMN capability_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS supervisor_plans (
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

CREATE TABLE IF NOT EXISTS plan_branches (
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

CREATE TABLE IF NOT EXISTS source_routing_plans (
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

CREATE INDEX IF NOT EXISTS idx_supervisor_plans_project_status_updated
  ON supervisor_plans(project_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supervisor_plans_operation
  ON supervisor_plans(operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plan_branches_plan_status_ready
  ON plan_branches(plan_id, status, priority DESC, original_ready_at ASC);
CREATE INDEX IF NOT EXISTS idx_plan_branches_project_item_status
  ON plan_branches(project_id, item_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_branches_idempotency
  ON plan_branches(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_source_routing_plans_item_updated
  ON source_routing_plans(project_id, item_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_sources_routing
  ON collection_sources(active, configured, domain, can_discover, priority);

-- Capacidades conhecidas. HARD FILTER ocorre antes do score.
UPDATE collection_sources
SET domain='ANIME', capability_version=60
WHERE LOWER(name) LIKE '%fandom%' OR LOWER(name) LIKE '%wikia%' OR LOWER(name) LIKE '%zerochan%' OR LOWER(name) LIKE '%konachan%';

UPDATE collection_sources
SET domain='GAMES', supported_universes='["POKEMON"]', capability_version=60
WHERE LOWER(name) LIKE '%pokeapi%' OR LOWER(name) LIKE '%bulbagarden%';

UPDATE collection_sources
SET domain='GAMES', capability_version=60
WHERE LOWER(name) LIKE '%spriter%';

UPDATE collection_sources
SET domain='MULTI', capability_version=60
WHERE LOWER(name) LIKE '%youtube%' OR LOWER(name) LIKE '%pinterest%' OR LOWER(name) LIKE '%brave%' OR LOWER(name) LIKE '%openverse%' OR LOWER(name) LIKE '%wikimedia%';

UPDATE collection_sources
SET can_discover = CASE WHEN method IN ('GET','LOOKUP','DISCOVERY') THEN 1 ELSE 0 END,
    can_materialize = 1,
    requires_external_search = CASE WHEN method='DISCOVERY' THEN 1 ELSE 0 END,
    configured = 1,
    capability_version = 60;

-- Fontes que exigem segredo não devem ser consideradas configuradas apenas por existirem no D1.
-- O runtime revalida o segredo antes do roteamento. Aqui deixamos o estado conservador para as conhecidas.
UPDATE collection_sources
SET configured=0
WHERE api_key_env IS NOT NULL AND TRIM(api_key_env)<>'';

-- Discovery Fandom direto para os universos usados nos testes operacionais.
INSERT OR IGNORE INTO collection_sources(
  id,name,base_url,method,query_param,limit_param,image_path,thumbnail_path,priority,active,
  api_key_env,api_key_header,headers_json,user_agent,timeout_ms,note,query_count,found_count,unique_count,
  materialized_count,failure_count,total_duration_ms,created_at,updated_at,
  domain,supported_universes,supported_composition_classes,can_discover,can_materialize,requires_external_search,configured,capability_version
) VALUES
('SRC-FANDOM-NARUTO-DISCOVERY','Fandom Naruto Discovery','https://naruto.fandom.com/api.php?action=query&generator=search&prop=pageimages&piprop=original%7Cthumbnail&pithumbsize=1200&format=json&origin=*','GET','gsrsearch','gsrlimit','query.pages.*.original.source','query.pages.*.thumbnail.source',1,1,NULL,NULL,'{}','CorvoLibrary/6.0',6000,'Discovery direto via MediaWiki API para Naruto; não depende de Brave.',0,0,0,0,0,0,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000,'ANIME','["NARUTO","BORUTO"]','["ISOLATED","CONTEXTUAL"]',1,1,0,1,60),
('SRC-FANDOM-MHA-DISCOVERY','Fandom MHA Discovery','https://myheroacademia.fandom.com/api.php?action=query&generator=search&prop=pageimages&piprop=original%7Cthumbnail&pithumbsize=1200&format=json&origin=*','GET','gsrsearch','gsrlimit','query.pages.*.original.source','query.pages.*.thumbnail.source',1,1,NULL,NULL,'{}','CorvoLibrary/6.0',6000,'Discovery direto via MediaWiki API para My Hero Academia; não depende de Brave.',0,0,0,0,0,0,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000,'ANIME','["MY HERO ACADEMIA","BOKU NO HERO ACADEMIA"]','["ISOLATED","CONTEXTUAL"]',1,1,0,1,60);

INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES
('supervisor_plan_policy_version','V60',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_plan_packet_size','20',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_plan_max_parallelism','8',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_plan_candidate_buffer_min','2',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_plan_candidate_buffer_target','3',CAST(strftime('%s','now') AS INTEGER)*1000),
('supervisor_plan_max_wip','80',CAST(strftime('%s','now') AS INTEGER)*1000),
('source_routing_hard_filter','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('source_routing_version','60',CAST(strftime('%s','now') AS INTEGER)*1000);
