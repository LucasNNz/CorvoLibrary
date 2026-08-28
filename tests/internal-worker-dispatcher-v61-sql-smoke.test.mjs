import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function migratedDb() {
  const db = new DatabaseSync(':memory:');
  const dir = join(root, 'drizzle');
  for (const name of readdirSync(dir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()) {
    db.exec(readFileSync(join(dir, name), 'utf8'));
  }
  return db;
}

test('V61 schema accepts 115 plan branches in D1-sized chunks and preserves all rows', () => {
  const db = migratedDb();
  const t = Date.now();
  db.prepare(`INSERT INTO automatic_projects(id,name,status,created_at,updated_at,pipeline_status,project_domain,total_items,collecting_count,pending_count)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('P-SMOKE','Smoke 115','PROCESSING',t,t,'PROCESSANDO','ANIME',115,115,115);
  db.prepare(`INSERT INTO supervisor_plans(id,project_id,operation_id,idempotency_key,status,priority,intent,scope_json,max_parallelism,
    stop_conditions_json,success_conditions_json,fallback_policy_json,source_policy_json,qa_policy_json,relink_policy_json,technical_policy_json,
    metadata_json,result_summary_json,project_version_at_creation,policy_version,accepted_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('PLAN-SMOKE','P-SMOKE','OP-SMOKE','OP-SMOKE','DISPATCHING',1,'EXECUTE_UNTIL_DIVERGENCE','{}',8,'[]','[]','{}','{}','{}','{}','{}','{}','{}',1,'V61',t,t,t);

  const itemStmt = db.prepare(`INSERT INTO automatic_project_items(id,project_id,version,item_key,term,status,priority,created_at,updated_at,composition_class,strategy_state,item_domain,stage,stage_ready_at,original_ready_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const branchStmt = db.prepare(`INSERT INTO plan_branches(id,plan_id,project_id,item_id,stage,branch_type,priority,status,ready_at,original_ready_at,worker_type,worker_domain,attempt,max_attempts,idempotency_key,payload_json,result_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const ids = [];
  for (let i=0;i<115;i++) {
    const id = `I-${String(i).padStart(3,'0')}`; ids.push(id);
    itemStmt.run(id,'P-SMOKE',1,`item-${i}`,`Naruto ${i}`,'SEARCHING_EXTERNALLY',1,t+i,t+i,'ISOLATED','{}','ANIME','COLETA',t+i,t+i);
  }
  const chunkSize = 20;
  let chunks = 0;
  for (let start=0; start<ids.length; start+=chunkSize) {
    db.exec('BEGIN');
    try {
      for (const id of ids.slice(start,start+chunkSize)) {
        const i = Number(id.slice(2));
        branchStmt.run(`B-${i}`,'PLAN-SMOKE','P-SMOKE',id,'COLETA','DISCOVERY',1,'READY',t+i,t+i,'COLLECTOR','ANIME',0,3,`PLAN-SMOKE:${id}:DISCOVERY:${t+i}`,'{}','{}',t,t);
      }
      db.exec('COMMIT'); chunks++;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  assert.equal(chunks, 6);
  assert.equal(db.prepare('SELECT count(*) AS n FROM plan_branches').get().n, 115);
  db.close();
});

test('V61 atomic READY claim allows only one consumer to win the same work item', () => {
  const db = migratedDb();
  const t = Date.now();
  db.prepare(`INSERT INTO automatic_projects(id,name,status,created_at,updated_at,pipeline_status,project_domain,total_items,collecting_count,pending_count)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('P-CAS','CAS','PROCESSING',t,t,'PROCESSANDO','ANIME',1,1,1);
  db.prepare(`INSERT INTO automatic_project_items(id,project_id,version,item_key,term,status,priority,created_at,updated_at,composition_class,strategy_state,item_domain,stage,stage_ready_at,original_ready_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('I-CAS','P-CAS',1,'item','Naruto','SEARCHING_EXTERNALLY',1,t,t,'ISOLATED','{}','ANIME','COLETA',t,t);
  db.prepare(`INSERT INTO worker_work_items(id,scope_type,scope_id,project_id,project_domain,item_id,stage,worker_type,priority,resume_priority,status,ready_at,original_ready_at,attempts,payload_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('W-CAS','ITEM','I-CAS','P-CAS','ANIME','I-CAS','COLETA','COLLECTOR',1,0,'READY',t,t,0,'{}',t,t);

  const claim = db.prepare(`UPDATE worker_work_items SET status='LEASED', lease_owner_worker_id=?, lease_execution_id=?, lease_started_at=?, lease_last_seen_at=?, lease_expires_at=?, attempts=attempts+1, last_action='INTERNAL_DISPATCH_CLAIM', updated_at=?
    WHERE id=? AND status='READY' AND (lease_expires_at IS NULL OR lease_expires_at<?)`);
  const expires = t + 600000;
  const first = claim.run('INTERNAL-COLLECTOR-01','E1',t,t,expires,t,'W-CAS',t);
  const second = claim.run('INTERNAL-COLLECTOR-02','E2',t,t,expires,t,'W-CAS',t);
  assert.equal(first.changes, 1);
  assert.equal(second.changes, 0);
  const row = db.prepare('SELECT status,lease_owner_worker_id,attempts FROM worker_work_items WHERE id=?').get('W-CAS');
  assert.equal(row.status, 'LEASED');
  assert.equal(row.lease_owner_worker_id, 'INTERNAL-COLLECTOR-01');
  assert.equal(row.attempts, 1);
  db.close();
});
