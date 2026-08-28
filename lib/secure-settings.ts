import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import { decryptPersistedConfig, encryptPersistedConfig, persistedConfigKeySource } from "./config-crypto";
import { LEGACY_CONFIG_REFERENCE, type CloudflareConnectionManifest } from "./legacy-config-reference";
import { ensureBootstrapSettingsTable } from "./bootstrap-db";

const CLOUDFLARE_KEY = LEGACY_CONFIG_REFERENCE.cloudflareSecretSettingKey;
const CLOUDFLARE_MANIFEST_KEY = LEGACY_CONFIG_REFERENCE.cloudflareManifestSettingKey;
const SUPERVISOR_KEY = LEGACY_CONFIG_REFERENCE.supervisorSecretSettingKey;

export type CloudflareConnection = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  d1ApiToken?: string;
  d1DatabaseId?: string;
  d1DatabaseName?: string;
};

export type SupervisorConnection = {
  provider: "cloudflare" | "openai" | "external";
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  cloudflareModel: string;
  openaiApiKey: string;
  openaiModel: string;
  externalEndpoint: string;
  externalToken: string;
};

function normalizeCloudflareConnection(connection: CloudflareConnection): CloudflareConnection {
  const accountValue = connection.accountId.trim();
  const base = {
    ...connection,
    d1ApiToken: connection.d1ApiToken?.trim() || "",
    d1DatabaseId: connection.d1DatabaseId?.trim() || "",
    d1DatabaseName: connection.d1DatabaseName?.trim() || "",
  };
  if (!/^https:\/\//i.test(accountValue)) return { ...base, accountId: accountValue, endpoint: connection.endpoint?.trim() || "" };
  const parsed = new URL(accountValue);
  if (!parsed.hostname.endsWith(".r2.cloudflarestorage.com")) throw new Error("Endpoint R2 salvo é inválido.");
  const accountId = parsed.hostname.slice(0, -".r2.cloudflarestorage.com".length);
  return { ...base, accountId, endpoint: connection.endpoint?.trim() || parsed.origin };
}

async function getCloudflareManifest(): Promise<CloudflareConnectionManifest | null> {
  await ensureBootstrapSettingsTable();
  const [row] = await getDb().select().from(settings).where(eq(settings.key, CLOUDFLARE_MANIFEST_KEY)).limit(1);
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<CloudflareConnectionManifest>;
    return {
      version: 1,
      accountId: String(parsed.accountId || ""),
      bucket: String(parsed.bucket || LEGACY_CONFIG_REFERENCE.expectedR2Bucket),
      accessKeyId: String(parsed.accessKeyId || ""),
      endpoint: String(parsed.endpoint || ""),
      d1DatabaseId: String(parsed.d1DatabaseId || ""),
      d1DatabaseName: String(parsed.d1DatabaseName || ""),
      source: parsed.source === "legacy-import" || parsed.source === "legacy-reference" ? parsed.source : "saved",
      updatedAt: String(parsed.updatedAt || ""),
    };
  } catch {
    return null;
  }
}

function referenceManifest(): CloudflareConnectionManifest {
  return {
    version: 1, accountId: "", bucket: LEGACY_CONFIG_REFERENCE.expectedR2Bucket, accessKeyId: "", endpoint: "",
    d1DatabaseId: "", d1DatabaseName: "", source: "legacy-reference", updatedAt: "",
  };
}

async function saveCloudflareManifest(connection: CloudflareConnection, source: CloudflareConnectionManifest["source"] = "saved") {
  const manifest: CloudflareConnectionManifest = {
    version: 1,
    accountId: connection.accountId,
    bucket: connection.bucket || LEGACY_CONFIG_REFERENCE.expectedR2Bucket,
    accessKeyId: connection.accessKeyId,
    endpoint: connection.endpoint || "",
    d1DatabaseId: connection.d1DatabaseId || "",
    d1DatabaseName: connection.d1DatabaseName || "",
    source,
    updatedAt: new Date().toISOString(),
  };
  await getDb().insert(settings).values({ key: CLOUDFLARE_MANIFEST_KEY, value: JSON.stringify(manifest), updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(manifest), updatedAt: new Date() } });
  return manifest;
}

export async function getCloudflareConnection() {
  await ensureBootstrapSettingsTable();
  const [row] = await getDb().select().from(settings).where(eq(settings.key, CLOUDFLARE_KEY)).limit(1);
  const manifest = await getCloudflareManifest() || referenceManifest();
  if (!row?.value) return { connection: null, manifest, updatedAt: null, locked: false };
  try {
    const connection = normalizeCloudflareConnection(await decryptPersistedConfig<CloudflareConnection>(row.value));
    // Backfill the recoverable, non-secret manifest after a successful legacy decrypt.
    const persistedManifest = await saveCloudflareManifest(connection, manifest.source === "legacy-reference" ? "legacy-import" : manifest.source);
    return { connection, manifest: persistedManifest, updatedAt: row.updatedAt, locked: false };
  } catch {
    // A D1 import may contain a config encrypted with an unknown legacy key.
    // Keep the encrypted value untouched and use the non-secret manifest/reference to prefill the UI.
    return { connection: null, manifest, updatedAt: row.updatedAt, locked: true };
  }
}

function normalizeSupervisorConnection(connection: SupervisorConnection): SupervisorConnection {
  const provider = connection.provider === "openai" || connection.provider === "external" ? connection.provider : "cloudflare";
  const externalEndpoint = connection.externalEndpoint?.trim() || "";
  if (externalEndpoint && !/^https:\/\//i.test(externalEndpoint)) throw new Error("O endpoint externo do Supervisor IA deve usar HTTPS.");
  return {
    provider,
    cloudflareAccountId: connection.cloudflareAccountId?.trim() || "",
    cloudflareApiToken: connection.cloudflareApiToken?.trim() || "",
    cloudflareModel: connection.cloudflareModel?.trim() || "@cf/qwen/qwen3.8-27b",
    openaiApiKey: connection.openaiApiKey?.trim() || "",
    openaiModel: connection.openaiModel?.trim() || "gpt-5.6-sol",
    externalEndpoint,
    externalToken: connection.externalToken?.trim() || "",
  };
}

export async function getSupervisorConnection() {
  await ensureBootstrapSettingsTable();
  const [row] = await getDb().select().from(settings).where(eq(settings.key, SUPERVISOR_KEY)).limit(1);
  if (!row?.value) return null;
  try {
    return { connection: normalizeSupervisorConnection(await decryptPersistedConfig<SupervisorConnection>(row.value)), updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

export async function saveSupervisorConnection(connection: SupervisorConnection) {
  await ensureBootstrapSettingsTable();
  const now = new Date();
  const normalized = normalizeSupervisorConnection(connection);
  const value = await encryptPersistedConfig(normalized);
  await getDb().insert(settings).values({ key: SUPERVISOR_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  return { connection: normalized, updatedAt: now };
}

export function safeSupervisorConnection(value: Awaited<ReturnType<typeof getSupervisorConnection>>) {
  if (!value) return {
    configured: false, provider: "cloudflare" as const, cloudflareAccountId: "", cloudflareModel: "@cf/qwen/qwen3.8-27b",
    hasCloudflareToken: false, openaiModel: "gpt-5.6-sol", hasOpenAiKey: false, externalEndpoint: "", hasExternalToken: false, updatedAt: null,
  };
  const connection = value.connection;
  const configured = connection.provider === "cloudflare"
    ? Boolean(connection.cloudflareAccountId && connection.cloudflareApiToken)
    : connection.provider === "openai" ? Boolean(connection.openaiApiKey) : Boolean(connection.externalEndpoint);
  return {
    configured, provider: connection.provider, cloudflareAccountId: connection.cloudflareAccountId,
    cloudflareModel: connection.cloudflareModel, hasCloudflareToken: Boolean(connection.cloudflareApiToken),
    openaiModel: connection.openaiModel, hasOpenAiKey: Boolean(connection.openaiApiKey),
    externalEndpoint: connection.externalEndpoint, hasExternalToken: Boolean(connection.externalToken), updatedAt: value.updatedAt,
  };
}

export async function saveCloudflareConnection(connection: CloudflareConnection) {
  await ensureBootstrapSettingsTable();
  const now = new Date();
  const normalized = normalizeCloudflareConnection(connection);
  const value = await encryptPersistedConfig(normalized);
  await getDb().insert(settings).values({ key: CLOUDFLARE_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  const manifest = await saveCloudflareManifest(normalized, "saved");
  return { connection: normalized, manifest, updatedAt: now, locked: false };
}

export function safeCloudflareConnection(value: Awaited<ReturnType<typeof getCloudflareConnection>>) {
  const manifest = value?.manifest || referenceManifest();
  if (!value?.connection) return {
    configured: false, accountId: manifest.accountId, bucket: manifest.bucket, accessKeyId: manifest.accessKeyId, endpoint: manifest.endpoint, hasSecret: false,
    d1Configured: false, d1DatabaseId: manifest.d1DatabaseId, d1DatabaseName: manifest.d1DatabaseName, hasD1Token: false,
    needsReconfigure: Boolean(value?.locked), encryptionBootstrap: persistedConfigKeySource(), updatedAt: value?.updatedAt || null,
    configReference: manifest.source, inheritedProfile: Boolean(value?.locked || manifest.source !== "saved"),
  };
  const connection = value.connection;
  return {
    configured: Boolean(connection.accountId && connection.bucket && connection.accessKeyId && connection.secretAccessKey),
    accountId: connection.accountId,
    bucket: connection.bucket,
    accessKeyId: connection.accessKeyId,
    endpoint: connection.endpoint || "",
    hasSecret: Boolean(connection.secretAccessKey),
    d1Configured: Boolean(connection.accountId && connection.d1ApiToken && connection.d1DatabaseId),
    d1DatabaseId: connection.d1DatabaseId || "",
    d1DatabaseName: connection.d1DatabaseName || "",
    hasD1Token: Boolean(connection.d1ApiToken),
    needsReconfigure: false,
    encryptionBootstrap: persistedConfigKeySource(),
    updatedAt: value.updatedAt,
    configReference: value.manifest?.source || "saved", inheritedProfile: Boolean(value.manifest?.source === "legacy-import"),
  };
}
