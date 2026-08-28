/**
 * Server-side encryption for persisted application settings.
 *
 * v2 uses a stable Library master key. The master key is wrapped both by the
 * current Turso token (automatic runtime access) and by the administrator
 * password (recovery after token rotation). v1/legacy ciphertext remains
 * readable during migration when its historical bootstrap key is available.
 */
import { getLibraryMasterKey } from "./master-key";

function legacySourceSecret() {
  const legacy = process.env.CORVO_CONFIG_ENCRYPTION_KEY?.trim() || "";
  if (legacy.length >= 32) return legacy;
  const turso = process.env.TURSO_AUTH_TOKEN?.trim() || "";
  if (turso.length >= 20) return `corvo-library:persisted-config:v1:${turso}`;
  throw new Error("SECURE_SETTINGS_BOOTSTRAP_UNAVAILABLE");
}

function bytesToBase64(bytes: Uint8Array) { return Buffer.from(bytes).toString("base64"); }
function base64ToBytes(value: string) { return Uint8Array.from(Buffer.from(value, "base64")); }

async function keyFromBytes(bytes: Uint8Array) {
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function legacyCryptoKey() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacySourceSecret()));
  return keyFromBytes(new Uint8Array(digest));
}

export async function encryptPersistedConfig(value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keyFromBytes(await getLibraryMasterKey()),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `v2.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptPersistedConfig<T>(value: string): Promise<T> {
  const parts = value.split(".");
  const v2 = parts.length === 3 && parts[0] === "v2";
  const v1 = parts.length === 3 && parts[0] === "v1";
  const ivValue = (v2 || v1) ? parts[1] : parts[0];
  const encryptedValue = (v2 || v1) ? parts[2] : parts[1];
  if (!ivValue || !encryptedValue) throw new Error("PERSISTED_CONFIG_INVALID");
  const key = v2 ? await keyFromBytes(await getLibraryMasterKey()) : await legacyCryptoKey();
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(ivValue) }, key, base64ToBytes(encryptedValue));
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

export function persistedConfigKeySource() {
  return "LIBRARY_MASTER_KEY" as const;
}
