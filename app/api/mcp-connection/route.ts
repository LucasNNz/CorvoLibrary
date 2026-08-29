import { getOrCreateMcpCode, isOwnerRequest, ownerOnly, rotateMcpCode } from "../../../lib/mcp-access";

function payload(request: Request, code: string) {
  const origin = new URL(request.url).origin;
  return {
    code,
    mcp_url: `${origin}/c/${encodeURIComponent(code)}/mcp`,
    plugin_name: "Corvo Library",
    description: "Administra integralmente a biblioteca visual Corvo por MCP.",
    transport: "streamable_http",
    authentication_type: "none",
    auth: "No ChatGPT selecione Sem autenticação. O código revogável já está incorporado ao endereço.",
    deployment_requirement: "O domínio de produção precisa estar público na Vercel (Vercel Authentication/Deployment Protection desativado). O painel continua protegido pelo login interno da Library.",
  };
}

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json(payload(request, await getOrCreateMcpCode()), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json(payload(request, await rotateMcpCode()), { headers: { "cache-control": "no-store" } });
}
