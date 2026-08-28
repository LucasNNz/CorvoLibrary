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
  for (const name of readdirSync(dir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()) db.exec(readFileSync(join(dir, name), 'utf8'));
  return db;
}

test('V61.1 FAST PUSH operation_id is unique and candidates keep independent states', () => {
  const db = migratedDb();
  const t = Date.now();
  const insert = db.prepare(`INSERT INTO fast_push_candidates(id,operation_id,source_url,source_type,concept,tags,search_metadata,status,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('FPC-1','OP-1','https://example.test/1.jpg','WEB','Naruto','[]','{}','PENDING_ANALYSIS',1,t,t);
  insert.run('FPC-2','OP-2','https://example.test/2.jpg','WEB','Kakashi','[]','{}','FAILED_HTTP',1,t,t);
  assert.equal(db.prepare(`SELECT count(*) AS n FROM fast_push_candidates`).get().n, 2);
  assert.throws(() => insert.run('FPC-3','OP-1','https://example.test/3.jpg','WEB','Gaara','[]','{}','PENDING_ANALYSIS',1,t,t));
  db.prepare(`UPDATE fast_push_candidates SET status='APPROVED_CANDIDATE', analyzed_at=? WHERE id='FPC-1'`).run(t+1);
  db.prepare(`UPDATE fast_push_candidates SET status='PROMOTED_TO_ASSET', promoted_at=? WHERE id='FPC-1'`).run(t+2);
  assert.equal(db.prepare(`SELECT status FROM fast_push_candidates WHERE id='FPC-1'`).get().status, 'PROMOTED_TO_ASSET');
  assert.equal(db.prepare(`SELECT status FROM fast_push_candidates WHERE id='FPC-2'`).get().status, 'FAILED_HTTP');
  db.close();
});


test('V61.2 FAST PUSH project bridge columns persist canonical pending linkage', () => {
  const db = migratedDb();
  const columns = new Set(db.prepare(`PRAGMA table_info(fast_push_candidates)`).all().map((row) => row.name));
  for (const name of ['project_item_id','project_link_status','materialization_batch_id','materialization_item_id','materialization_file_id','supervisor_candidate_id','linked_at']) assert.ok(columns.has(name), name);
  const t = Date.now();
  db.prepare(`INSERT INTO fast_push_candidates(id,operation_id,project_id,item_id,project_item_id,project_link_status,source_url,source_type,tags,search_metadata,status,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('FPC-BRIDGE','OP-BRIDGE','PROJ-1','PITEM-1','PITEM-1','LINKED_PARA_QA_VISUAL','https://example.test/x.jpg','WEB','[]','{}','PENDING_ANALYSIS',1,t,t);
  const row = db.prepare(`SELECT project_item_id,project_link_status FROM fast_push_candidates WHERE id='FPC-BRIDGE'`).get();
  assert.equal(row.project_item_id, 'PITEM-1');
  assert.equal(row.project_link_status, 'LINKED_PARA_QA_VISUAL');
  db.close();
});
