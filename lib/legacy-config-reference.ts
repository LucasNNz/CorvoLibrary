/**
 * Non-secret reference describing where the current Corvo Library came from.
 * No credential or token is stored here.
 *
 * Migration policy:
 * - the imported `settings` table remains authoritative;
 * - encrypted settings are copied byte-for-byte from D1 to Turso;
 * - the UI writes back to the same logical profile and overwrites it on update;
 * - a non-secret manifest is maintained separately so metadata survives key rotation.
 */
export const LEGACY_CONFIG_REFERENCE = Object.freeze({
  sourceApp: "https://corvo-library.contatolucasna388076.chatgpt.site",
  sourceProjectId: "appgprj_6a8a003f881481918ee941c02aa9f1b1",
  cloudflareSecretSettingKey: "secret_cloudflare_connection",
  cloudflareManifestSettingKey: "cloudflare_connection_manifest_v1",
  supervisorSecretSettingKey: "secret_supervisor_connection",
  mcpSettingKey: "mcp_connection_code",
  expectedR2Bucket: "corvo-library",
  version: 1,
});

export type CloudflareConnectionManifest = {
  version: 1;
  accountId: string;
  bucket: string;
  accessKeyId: string;
  endpoint: string;
  d1DatabaseId: string;
  d1DatabaseName: string;
  source: "environment" | "saved" | "legacy-import" | "legacy-reference";
  updatedAt: string;
};
