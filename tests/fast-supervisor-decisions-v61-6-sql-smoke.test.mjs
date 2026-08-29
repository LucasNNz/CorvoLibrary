import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function migratedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const dir = join(root, 'drizzle');
  for (const name of readdirSync(dir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()) {
    db.exec(readFileSync(join(dir, name), 'utf8'));
  }
  return db;
}

test('V61.6 all migrations create durable supervisor decision job queue', () => {
  const db = migratedDb();
  const cols = new Set(db.prepare(`PRAGMA table_info(supervisor_decision_jobs)`).all().map((row) => row.name));
  for (const name of ['operation_id','project_id','kind','status','payload_json','progress_json','attempts','lease_owner','lease_expires_at','started_at','completed_at']) assert.ok(cols.has(name), name);
  const indexes = new Set(db.prepare(`PRAGMA index_list(supervisor_decision_jobs)`).all().map((row) => row.name));
  assert.ok(indexes.has('idx_supervisor_decision_jobs_status_created'));
  assert.ok(indexes.has('idx_supervisor_decision_jobs_project_status'));
  assert.ok(indexes.has('idx_supervisor_decision_jobs_lease'));
  db.close();
});

test('V61.6 operation_id is a durable unique receipt and job FK belongs to project', () => {
  const db = migratedDb();
  const t = Date.now();
  db.prepare(`INSERT INTO automatic_projects(id,name,status,created_at,updated_at) VALUES(?,?,?,?,?)`).run('P-FASTACK','FAST ACK','READY',t,t);
  db.prepare(`INSERT INTO operation_results(operation_id,tool,project_id,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run('OP-FASTACK','aplicar_decisoes_supervisor_lote','P-FASTACK','RUNNING','{"phase":"QUEUED"}',t,t);
  db.prepare(`INSERT INTO supervisor_decision_jobs(id,operation_id,project_id,kind,status,payload_json,progress_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run('J-1','OP-FASTACK','P-FASTACK','PROJECT_QA','QUEUED','{"decisions":[]}','{"cursor":0,"results":[]}',0,t,t);
  assert.throws(() => db.prepare(`INSERT INTO supervisor_decision_jobs(id,operation_id,project_id,kind,status,payload_json,progress_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run('J-2','OP-FASTACK','P-FASTACK','PROJECT_QA','QUEUED','{}','{}',0,t,t));
  assert.throws(() => db.prepare(`INSERT INTO supervisor_decision_jobs(id,operation_id,project_id,kind,status,payload_json,progress_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run('J-3','OP-OTHER','P-NOT-EXISTS','PROJECT_QA','QUEUED','{}','{}',0,t,t));
  const row = db.prepare(`SELECT status,operation_id,project_id FROM supervisor_decision_jobs WHERE id='J-1'`).get();
  assert.equal(row.status, 'QUEUED');
  assert.equal(row.operation_id, 'OP-FASTACK');
  assert.equal(row.project_id, 'P-FASTACK');
  db.close();
});
