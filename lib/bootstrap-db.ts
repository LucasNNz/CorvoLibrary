import { getLibsqlClient } from './platform/runtime';

let inFlight: Promise<void> | null = null;

export function ensureBootstrapSettingsTable() {
  if (!inFlight) {
    inFlight = getLibsqlClient().executeMultiple(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `).then(() => undefined).finally(() => { inFlight = null; });
  }
  return inFlight;
}
