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

function insertProject(db, id='PROD-1') {
  const t = Date.now();
  db.prepare(`INSERT INTO automatic_projects(id,name,status,created_at,updated_at) VALUES(?,?,?,?,?)`).run(id,'Projeto Produção','READY',t,t);
  return t;
}

test('V61.4 all migrations apply and production operation ids remain idempotent per candidate', () => {
  const db = migratedDb(), t = insertProject(db);
  const projectCols = new Set(db.prepare(`PRAGMA table_info(automatic_projects)`).all().map((row) => row.name));
  for (const name of ['production_revision','production_zip_revision','production_zip_r2_key','production_zip_file_name','production_zip_size_bytes']) assert.ok(projectCols.has(name), name);
  db.prepare(`INSERT INTO project_production_assets(id,operation_id,project_id,kind,name,status,selected,source_type,r2_key,mime_type,size_bytes,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('TH-1','OP-TH-1','PROD-1','THUMB','a.png','THUMB_CANDIDATE',0,'CHAT_FILE','projects/PROD-1/production/thumbs/a.png','image/png',10,'abc',t,t);
  assert.throws(() => db.prepare(`INSERT INTO project_production_assets(id,operation_id,project_id,kind,name,status,selected,source_type,r2_key,mime_type,size_bytes,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('TH-2','OP-TH-1','PROD-1','THUMB','b.png','THUMB_CANDIDATE',0,'WEB','x','image/png',10,'def',t,t));
  db.prepare(`INSERT INTO project_title_candidates(id,operation_id,project_id,text,status,selected,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run('TI-1','OP-TI-1','PROD-1','Título A','TITLE_CANDIDATE',0,t,t);
  assert.throws(() => db.prepare(`INSERT INTO project_title_candidates(id,operation_id,project_id,text,status,selected,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run('TI-2','OP-TI-1','PROD-1','Título B','TITLE_CANDIDATE',0,t,t));
  db.close();
});

test('V61.4 project can keep multiple approved candidates while one is selected', () => {
  const db = migratedDb(), t = insertProject(db, 'PROD-2');
  const ins = db.prepare(`INSERT INTO project_title_candidates(id,operation_id,project_id,text,status,selected,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`);
  ins.run('T1','O1','PROD-2','Título 1','TITLE_APPROVED',1,t,t);
  ins.run('T2','O2','PROD-2','Título 2','TITLE_APPROVED',0,t,t);
  ins.run('T3','O3','PROD-2','Título 3','TITLE_REJECTED',0,t,t);
  const approved = db.prepare(`SELECT count(*) AS n FROM project_title_candidates WHERE project_id='PROD-2' AND status='TITLE_APPROVED'`).get().n;
  const selected = db.prepare(`SELECT count(*) AS n FROM project_title_candidates WHERE project_id='PROD-2' AND selected=1`).get().n;
  assert.equal(approved, 2);
  assert.equal(selected, 1);
  db.close();
});
