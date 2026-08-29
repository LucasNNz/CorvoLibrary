import { evaluateCollectionNeed, exportInventoryTabText, getInventoryDashboard, registerAssetConsultation, setStockPolicy } from "../../../lib/inventory-intelligence";
import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("format") === "txt") {
      const exported = await exportInventoryTabText({ aba: url.searchParams.get("tab") || "estoque", conceito: url.searchParams.get("concept") || "" });
      return new Response(`\uFEFF${exported.conteudo}`, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${exported.arquivo}"`, "cache-control": "no-store" } });
    }
    return Response.json(await getInventoryDashboard({ conceito: url.searchParams.get("concept") || "" }));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}

export async function PUT(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try { return Response.json(await setStockPolicy(await request.json() as Record<string, unknown>)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const input = await request.json() as Record<string, unknown>;
    return Response.json(input.acao === "avaliar" ? await evaluateCollectionNeed(input) : await registerAssetConsultation(input), { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}
