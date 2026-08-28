import { createClient, type Client } from "@libsql/client";

const MASTER_KEY_SETTING = "library_master_key_v1";

type WrappedValue = { iv: string; data: string };
type MasterKeyRecord = {
  version: 1;
  turso: WrappedValue;
  password: WrappedValue;
  passwordWrapSalt: string;
  createdAt: string;
  updatedAt: string;
};

let clientCache: Client | null = null;
let masterKeyCache: Uint8Array | null = null;

function client() {
  if (!clientCache) {
    const url = process.env.TURSO_DATABASE_URL?.trim();
    if (!url) throw new Error("VERCEL_ENV_REQUIRED:TURSO_DATABASE_URL");
    clientCache = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined });
  }
  return clientCache;
}

function b64(bytes: Uint8Array) { return Buffer.from(bytes).toString("base64"); }
function unb64(value: string) { return Uint8Array.from(Buffer.from(value, "base64")); }

async function ensureSettings() {
  await client().executeMultiple(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
}

async function sha256Bytes(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function aesKeyFromSecret(secret: string, purpose: string) {
  const material = await sha256Bytes(`corvo-library:${purpose}:${secret}`);
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function aesKeyFromPassword(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function wrap(raw: Uint8Array, key: CryptoKey): Promise<WrappedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, raw);
  return { iv: b64(iv), data: b64(new Uint8Array(encrypted)) };
}

async function unwrap(value: WrappedValue, key: CryptoKey) {
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(value.iv) }, key, unb64(value.data));
  return new Uint8Array(decrypted);
}

async function loadRecord(): Promise<MasterKeyRecord | null> {
  await ensureSettings();
  const result = await client().execute({ sql: "SELECT value FROM settings WHERE key=? LIMIT 1", args: [MASTER_KEY_SETTING] });
  const raw = String(result.rows[0]?.value || "");
  if (!raw) return null;
  try { return JSON.parse(raw) as MasterKeyRecord; } catch { throw new Error("LIBRARY_MASTER_KEY_RECORD_INVALID"); }
}

async function saveRecord(record: MasterKeyRecord) {
  const now = Date.now();
  await client().execute({
    sql: "INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    args: [MASTER_KEY_SETTING, JSON.stringify(record), now],
  });
}

function tursoSecret() {
  const token = process.env.TURSO_AUTH_TOKEN?.trim() || "";
  if (token.length < 20) throw new Error("TURSO_AUTH_TOKEN_REQUIRED_FOR_MASTER_KEY");
  return token;
}

async function tursoWrapKey() { return aesKeyFromSecret(tursoSecret(), "master-key:turso:v1"); }

export async function ensureLibraryMasterKey(password: string) {
  const existing = await loadRecord();
  if (existing) {
    try {
      const raw = await unwrap(existing.turso, await tursoWrapKey());
      masterKeyCache = raw;
      return raw;
    } catch {
      const salt = unb64(existing.passwordWrapSalt);
      const raw = await unwrap(existing.password, await aesKeyFromPassword(password, salt));
      const now = new Date().toISOString();
      const healed: MasterKeyRecord = { ...existing, turso: await wrap(raw, await tursoWrapKey()), updatedAt: now };
      await saveRecord(healed);
      masterKeyCache = raw;
      return raw;
    }
  }

  const raw = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const now = new Date().toISOString();
  const record: MasterKeyRecord = {
    version: 1,
    turso: await wrap(raw, await tursoWrapKey()),
    password: await wrap(raw, await aesKeyFromPassword(password, salt)),
    passwordWrapSalt: b64(salt),
    createdAt: now,
    updatedAt: now,
  };
  await saveRecord(record);
  masterKeyCache = raw;
  return raw;
}

export async function getLibraryMasterKey() {
  if (masterKeyCache) return masterKeyCache;
  const record = await loadRecord();
  if (!record) throw new Error("LIBRARY_MASTER_KEY_NOT_INITIALIZED");
  const raw = await unwrap(record.turso, await tursoWrapKey());
  masterKeyCache = raw;
  return raw;
}

export async function rewrapLibraryMasterKeyForPassword(currentPassword: string, newPassword: string) {
  const record = await loadRecord();
  if (!record) return ensureLibraryMasterKey(newPassword);
  let raw: Uint8Array;
  try {
    raw = await unwrap(record.password, await aesKeyFromPassword(currentPassword, unb64(record.passwordWrapSalt)));
  } catch {
    throw new Error("CURRENT_PASSWORD_INVALID");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const now = new Date().toISOString();
  const updated: MasterKeyRecord = {
    ...record,
    turso: await wrap(raw, await tursoWrapKey()),
    password: await wrap(raw, await aesKeyFromPassword(newPassword, salt)),
    passwordWrapSalt: b64(salt),
    updatedAt: now,
  };
  await saveRecord(updated);
  masterKeyCache = raw;
  return raw;
}

export function clearMasterKeyMemoryCache() { masterKeyCache = null; }
