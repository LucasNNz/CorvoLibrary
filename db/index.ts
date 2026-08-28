import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema';
import { getLibsqlClient } from '../lib/platform/runtime';

function createDatabase() {
  return drizzle(getLibsqlClient(), { schema });
}

let db: ReturnType<typeof createDatabase> | null = null;

export function getDb() {
  db ??= createDatabase();
  return db;
}
