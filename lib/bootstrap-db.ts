import { getLibsqlClient } from './platform/runtime';

let inFlight: Promise<void> | null = null;

export function ensureBootstrapSettingsTable(): Promise<void> {
  if (!inFlight) {
    const task = getLibsqlClient().executeMultiple(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `).then(() => undefined).finally(() => { if (inFlight === task) inFlight = null; });
    inFlight = task;
  }
  return inFlight!;
}
