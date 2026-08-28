-- V60+ — WORKSPACE DE POLÍTICAS OPERACIONAIS / APRENDIZADO INDUSTRIAL
-- Camada aditiva. Não altera CORE_RULES e não remove dados existentes.

CREATE TABLE IF NOT EXISTS operational_gaps (
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

CREATE TABLE IF NOT EXISTS operational_policies (
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

CREATE TABLE IF NOT EXISTS operational_policy_events (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_gaps_signature ON operational_gaps(signature);
CREATE INDEX IF NOT EXISTS idx_operational_gaps_status_occurrence ON operational_gaps(status, occurrence_count DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_gaps_project_item ON operational_gaps(project_id, item_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_policies_status_scope_domain ON operational_policies(status, scope_level, domain, priority DESC);
CREATE INDEX IF NOT EXISTS idx_operational_policies_universe_composition ON operational_policies(universe, composition_class, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_operational_policies_project_item ON operational_policies(project_id, item_id, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_operational_policies_key_version ON operational_policies(policy_key, version DESC);
CREATE INDEX IF NOT EXISTS idx_operational_policy_events_policy_time ON operational_policy_events(policy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_policy_events_project_time ON operational_policy_events(project_id, created_at DESC);

-- Políticas iniciais derivadas dos gaps operacionais já observados. São LEARNED_POLICY,
-- versionadas e reversíveis; CORE_RULES continuam fora desta tabela e têm precedência absoluta.
INSERT OR IGNORE INTO operational_policies(
  id,policy_key,name,description,category,status,rule_type,scope_level,propagation_level,
  domain,universe,condition_json,action_json,priority,confidence,created_by,version,
  created_at,updated_at
) VALUES
(
  'POL-V60-GLOBAL-SKIP-NOT-CONFIGURED','GLOBAL_SKIP_NOT_CONFIGURED','Pular fonte sem configuração',
  'Fonte que exige credencial/configuração indisponível deve ser removida antes da tentativa; não gerar decisão repetitiva para o Supervisor.',
  'API_COMPATIBILITY','PROMOTED','LEARNED_POLICY','GLOBAL',4,NULL,NULL,
  '{"requires_api_key":true,"configured":false}',
  '{"type":"SKIP_SOURCE","reason":"SKIPPED_BY_POLICY","supervisor_escalation":false}',
  100,99,'MIGRATION_V60_WORKSPACE',1,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000
),
(
  'POL-V60-ANIME-BLOCK-POKEAPI','ANIME_BLOCK_POKEAPI_NON_POKEMON','Bloquear PokeAPI fora de Pokémon',
  'PokeAPI não entra no roteamento de anime quando o universo não é Pokémon.',
  'SOURCE_ROUTING','PROMOTED','LEARNED_POLICY','DOMAIN',3,'ANIME',NULL,
  '{"source_contains":"pokeapi","universe_not":"POKEMON"}',
  '{"type":"BLOCK_SOURCE","reason":"POLICY_UNIVERSE_INCOMPATIBLE"}',
  100,99,'MIGRATION_V60_WORKSPACE',1,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000
),
(
  'POL-V60-ANIME-BLOCK-BULBAGARDEN','ANIME_BLOCK_BULBAGARDEN_NON_POKEMON','Bloquear Bulbagarden fora de Pokémon',
  'Bulbagarden não entra no roteamento de anime quando o universo não é Pokémon.',
  'SOURCE_ROUTING','PROMOTED','LEARNED_POLICY','DOMAIN',3,'ANIME',NULL,
  '{"source_contains":"bulbagarden","universe_not":"POKEMON"}',
  '{"type":"BLOCK_SOURCE","reason":"POLICY_UNIVERSE_INCOMPATIBLE"}',
  100,99,'MIGRATION_V60_WORKSPACE',1,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000
),
(
  'POL-V60-ANIME-BLOCK-SPRITERS','ANIME_BLOCK_SPRITERS_DEFAULT','Spriters só com política explícita em Anime',
  'Spriters Resource não deve ser rota genérica de anime; permitir somente por exceção mais específica.',
  'DOMAIN_COMPATIBILITY','ACTIVE','LEARNED_POLICY','DOMAIN',3,'ANIME',NULL,
  '{"source_contains":"spriter"}',
  '{"type":"BLOCK_SOURCE","reason":"POLICY_DOMAIN_INCOMPATIBLE"}',
  90,95,'MIGRATION_V60_WORKSPACE',1,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000
),
(
  'POL-V60-LARGE-PROJECT-BATCH','LARGE_PROJECT_BATCH_100','Projeto grande usa operação em lote',
  'Projetos com pelo menos 100 itens usam batch QA/relink 20, paralelismo 8, skip waiting e snapshot delta.',
  'PERFORMANCE','ACTIVE','LEARNED_POLICY','GLOBAL',4,NULL,NULL,
  '{"project_items_gte":100}',
  '{"type":"SET_PIPELINE_POLICY","qa_batch_size":20,"relink_batch_size":20,"parallelism":8,"skip_waiting":true,"delta_snapshot":true}',
  50,85,'MIGRATION_V60_WORKSPACE',1,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000
);

INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES
('operational_learning_enabled','true',CAST(strftime('%s','now') AS INTEGER)*1000),
('operational_policy_cache_ttl_ms','60000',CAST(strftime('%s','now') AS INTEGER)*1000),
('operational_policy_version','V60-WORKSPACE-1',CAST(strftime('%s','now') AS INTEGER)*1000),
('operational_policy_auto_global_promotion','false',CAST(strftime('%s','now') AS INTEGER)*1000);
