import { testR2Connection } from "../../../lib/platform/runtime";
import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";
import { resolveCorvoD1Database } from "../../../lib/cloudflare-admin";
import { getCloudflareConnection, safeCloudflareConnection, saveCloudflareConnection } from "../../../lib/secure-settings";

const headers = { "cache-control": "no-store" };
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json(safeCloudflareConnection(await getCloudflareConnection()), { headers });
}

export async function PUT(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  const payload = await request.json() as Record<string, unknown>;
  const current = await getCloudflareConnection();
  const currentConnection = current?.connection || null;
  const inherited = current?.manifest || null;
  const connection = {
    accountId: clean(payload.accountId) || currentConnection?.accountId || inherited?.accountId || "",
    bucket: clean(payload.bucket) || currentConnection?.bucket || inherited?.bucket || "",
    accessKeyId: clean(payload.accessKeyId) || currentConnection?.accessKeyId || inherited?.accessKeyId || "",
    secretAccessKey: clean(payload.secretAccessKey) || currentConnection?.secretAccessKey || "",
    endpoint: clean(payload.endpoint) || currentConnection?.endpoint || inherited?.endpoint || "",
    d1ApiToken: clean(payload.d1ApiToken) || currentConnection?.d1ApiToken || "",
    d1DatabaseId: clean(payload.d1DatabaseId) || currentConnection?.d1DatabaseId || inherited?.d1DatabaseId || "",
    d1DatabaseName: clean(payload.d1DatabaseName) || currentConnection?.d1DatabaseName || inherited?.d1DatabaseName || "",
  };

  // A known/inherited bucket name alone must not force R2 credentials during the
  // first D1 migration. This lets the operator provide only Account ID + D1 token
  // to recover the existing Library before rotating R2 credentials.
  const hasAnyR2 = Boolean(connection.accessKeyId || connection.secretAccessKey || connection.endpoint);
  if (hasAnyR2) {
    if (!connection.accountId || !connection.bucket || !connection.accessKeyId || !connection.secretAccessKey) {
      return Response.json({ error: "Para salvar o R2, preencha Account ID, Bucket, Access Key ID e Secret Access Key." }, { status: 400, headers });
    }
    const endpoint = connection.endpoint || `https://${connection.accountId}.r2.cloudflarestorage.com`;
    await testR2Connection({ endpoint, bucket: connection.bucket, accessKeyId: connection.accessKeyId, secretAccessKey: connection.secretAccessKey });
  }

  if (connection.d1ApiToken) {
    if (!connection.accountId) return Response.json({ error: "Informe o Account ID para validar o D1." }, { status: 400, headers });
    const database = await resolveCorvoD1Database(connection.accountId, connection.d1ApiToken, connection.d1DatabaseId, connection.d1DatabaseName);
    connection.d1DatabaseId = database.id;
    connection.d1DatabaseName = database.name;
  }

  if (!hasAnyR2 && !connection.d1ApiToken) {
    return Response.json({ error: "Informe ao menos a conexão R2 ou o token D1." }, { status: 400, headers });
  }

  const saved = await saveCloudflareConnection(connection);
  return Response.json({ ...safeCloudflareConnection(saved), bindingActive: hasAnyR2 }, { headers });
}
