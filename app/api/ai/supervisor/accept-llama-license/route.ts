import { acceptCloudflareLlamaLicense, LLAMA_VISION_MODEL } from "../../../../../lib/ai-supervisor";
import { isOwnerRequest, ownerOnly } from "../../../../../lib/mcp-access";
import { getCloudflareConnection, getSupervisorConnection } from "../../../../../lib/secure-settings";

const headers = { "cache-control": "no-store" };
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";

function publicError(error: unknown) {
  const message = error instanceof Error ? error.message : "CLOUDFLARE_AI_LICENSE_FAILED";
  if (message.includes("401")) return { status: 401, error: "Token do Workers AI inválido." };
  if (message.includes("403")) return { status: 403, error: "O token não possui permissão para aceitar a licença deste modelo." };
  if (message.includes("404")) return { status: 404, error: "Modelo ou conta Cloudflare não encontrados." };
  if (message.includes("429")) return { status: 429, error: "Limite temporário da Cloudflare. Aguarde e tente novamente." };
  if (message.includes("TIMEOUT") || message.includes("timed out")) return { status: 504, error: "A Cloudflare não respondeu dentro do prazo." };
  return { status: 400, error: "Não foi possível aceitar a licença do Llama." };
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const [current, storage] = await Promise.all([getSupervisorConnection(), getCloudflareConnection()]);
  const accountId = clean(payload.cloudflareAccountId) || current?.connection.cloudflareAccountId || storage?.connection?.accountId || "";
  const apiToken = clean(payload.cloudflareApiToken) || current?.connection.cloudflareApiToken || "";
  const model = clean(payload.cloudflareModel) || current?.connection.cloudflareModel || LLAMA_VISION_MODEL;
  if (model !== LLAMA_VISION_MODEL) return Response.json({ success: false, error: "Selecione o modelo Llama Vision indicado." }, { status: 400, headers });
  if (!accountId || !apiToken) return Response.json({ success: false, error: "Informe o Account ID e o token do Workers AI." }, { status: 400, headers });
  try {
    return Response.json(await acceptCloudflareLlamaLicense(accountId, apiToken, model), { headers });
  } catch (error) {
    const failure = publicError(error);
    return Response.json({ success: false, error: failure.error }, { status: failure.status, headers });
  }
}
