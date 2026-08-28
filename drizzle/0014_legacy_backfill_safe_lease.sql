-- V58 — LEGACY PROJECT BACKFILL + SAFE/REVERSIBLE LEASE ACQUISITION
-- Repairs V14/V15-era projects after state_version/materialized counters and multi-domain queues were introduced.
-- Idempotent: no assets/files are deleted or recreated.

-- If the currently active version has no items but an older/newer stored version does, select the newest real item version.
UPDATE automatic_projects
SET active_version = (
  SELECT MAX(i.version) FROM automatic_project_items i WHERE i.project_id = automatic_projects.id
)
WHERE EXISTS (SELECT 1 FROM automatic_project_items i WHERE i.project_id = automatic_projects.id)
  AND NOT EXISTS (
    SELECT 1 FROM automatic_project_items i
    WHERE i.project_id = automatic_projects.id AND i.version = automatic_projects.active_version
  );

-- Backfill Naruto/anime legacy projects that were introduced before project_domain was meaningful.
UPDATE automatic_projects
SET project_domain = 'ANIME'
WHERE COALESCE(project_domain,'GENERAL') = 'GENERAL'
  AND (
    UPPER(name) LIKE '%NARUTO%'
    OR UPPER(name) LIKE '%BORUTO%'
    OR UPPER(name) LIKE '%MY HERO ACADEMIA%'
    OR UPPER(name) LIKE '%BOKU NO HERO%'
    OR UPPER(name) LIKE '%ONE PIECE%'
    OR UPPER(name) LIKE '%DEMON SLAYER%'
    OR UPPER(name) LIKE '%KIMETSU%'
    OR UPPER(name) LIKE '%JUJUTSU KAISEN%'
    OR UPPER(name) LIKE '%CHAINSAW MAN%'
    OR UPPER(name) LIKE '%DRAGON BALL%'
    OR UPPER(name) LIKE '%DANDADAN%'
    OR UPPER(name) LIKE '%SAKAMOTO%'
    OR UPPER(name) LIKE '%JOJO%'
    OR EXISTS (
      SELECT 1 FROM automatic_project_items i
      WHERE i.project_id = automatic_projects.id
        AND i.version = automatic_projects.active_version
        AND (
          UPPER(COALESCE(i.universe,'')) LIKE '%NARUTO%'
          OR UPPER(COALESCE(i.universe,'')) LIKE '%BORUTO%'
          OR UPPER(COALESCE(i.universe,'')) LIKE '%MY HERO ACADEMIA%'
          OR UPPER(COALESCE(i.universe,'')) LIKE '%ONE PIECE%'
          OR UPPER(COALESCE(i.universe,'')) LIKE '%DEMON SLAYER%'
          OR UPPER(COALESCE(i.universe,'')) LIKE '%JUJUTSU KAISEN%'
          OR UPPER(COALESCE(i.universe,'')) LIKE '%CHAINSAW MAN%'
          OR UPPER(COALESCE(i.universe,'')) LIKE '%DRAGON BALL%'
        )
    )
  );

UPDATE automatic_project_items
SET item_domain = (
      SELECT p.project_domain FROM automatic_projects p WHERE p.id = automatic_project_items.project_id
    ),
    stage_ready_at = COALESCE(stage_ready_at, updated_at, created_at),
    original_ready_at = COALESCE(original_ready_at, created_at)
WHERE version = (SELECT p.active_version FROM automatic_projects p WHERE p.id = automatic_project_items.project_id)
  AND (item_domain IS NULL OR item_domain = '' OR item_domain = 'GENERAL');

-- Materialized summary counters for the active canonical version.
UPDATE automatic_projects SET
  total_items = (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version),
  approved_count = (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version AND i.status IN ('APPROVED','LINKED_FROM_LIBRARY','LINKED_FROM_FAMILY')),
  frozen_count = (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version AND i.status='FROZEN'),
  collecting_count = (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version AND i.status IN ('QUEUED','PARSING','SEARCHING_EXTERNALLY','SEARCHING_LIBRARY','COLLECTING','WAITING_LIBRARY','WAITING_EXTERNAL_SEARCH','DISCOVERED')),
  materializing_count = (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version AND i.status IN ('READY_FOR_MATERIALIZATION','MATERIALIZATION_PENDING','MATERIALIZING')),
  waiting_qa_count = (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version AND i.status IN ('QA_READY','READY_FOR_VISUAL_QA','WAITING_VISUAL_QA')),
  relink_count = (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version AND i.status='RELINK_REQUIRED'),
  technical_count = (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version AND i.status IN ('TECHNICAL_CORRECTION_REQUIRED','CORRECAO_TECNICA_PERMITIDA')),
  waiting_seed_count = (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version AND i.status IN ('WAITING_FAMILY_SEED','WAITING_DEPENDENCY')),
  failed_count = (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version AND i.status IN ('FAILED','FAILED_SEMANTIC','FAILED_INFRASTRUCTURE','REJECTED','CANCELLED','CANCELED','ERROR_REAL')),
  pending_count = (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version AND i.status NOT IN ('APPROVED','FROZEN','LINKED_FROM_LIBRARY','LINKED_FROM_FAMILY')),
  state_version = CASE
    WHEN (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version) > 0
      THEN MAX(2, state_version + 1)
    ELSE state_version
  END,
  ready_at = COALESCE(ready_at, created_at),
  original_ready_at = COALESCE(original_ready_at, created_at),
  last_action = CASE
    WHEN (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version) > 0
      THEN 'LEGACY_BACKFILL_V58'
    ELSE last_action
  END,
  updated_at = CASE
    WHEN (SELECT COUNT(*) FROM automatic_project_items i WHERE i.project_id=automatic_projects.id AND i.version=automatic_projects.active_version) > 0
      THEN CAST(strftime('%s','now') AS INTEGER)*1000
    ELSE updated_at
  END;

-- Derive a usable pipeline/next action for non-terminal legacy projects.
UPDATE automatic_projects
SET pipeline_status = CASE
      WHEN waiting_qa_count > 0 THEN 'AGUARDANDO_QA'
      WHEN relink_count > 0 THEN 'AGUARDANDO_RELINK'
      WHEN materializing_count > 0 THEN 'AGUARDANDO_MATERIALIZACAO'
      WHEN pending_count > 0 THEN 'EM_PROCESSAMENTO'
      ELSE pipeline_status
    END,
    next_action = CASE
      WHEN waiting_qa_count > 0 THEN 'QA_VISUAL'
      WHEN relink_count > 0 THEN 'RELINK'
      WHEN materializing_count > 0 THEN 'MATERIALIZAR'
      WHEN technical_count > 0 THEN 'CORRECAO_TECNICA'
      WHEN pending_count > 0 THEN 'COLETAR'
      WHEN total_items > 0 THEN 'GERAR_ZIP'
      ELSE next_action
    END
WHERE status NOT IN ('CONCLUIDO_MANUAL','COMPLETED','COMPLETED_WITH_WARNINGS','FORCED_CLOSED','CANCELLED','GROUPED_ARCHIVED')
  AND pipeline_status NOT IN ('CONCLUIDO','CANCELADO');

INSERT OR REPLACE INTO settings(key,value,updated_at)
VALUES('legacy_backfill_version','V58',CAST(strftime('%s','now') AS INTEGER)*1000);
