import { getOrCreateMcpCode, isOwnerRequest, ownerOnly, rotateMcpCode } from "../../../lib/mcp-access";

function payload(request: Request, code: string) {
  const origin = new URL(request.url).origin;
  return { code, mcp_url: `${origin}/c/${encodeURIComponent(code)}/mcp`, plugin_name: "Corvo Library", description: "Administra integralmente a biblioteca visual Corvo por MCP.", transport: "streamable_http", auth: "Sem autenticação no ChatGPT; código revogável incorporado ao endereço" };
}

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json(payload(request, await getOrCreateMcpCode()), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json(payload(request, await rotateMcpCode()), { headers: { "cache-control": "no-store" } });
}
