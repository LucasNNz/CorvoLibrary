import { createCollectionBatch, executeCollection, getCollectionBatch, getCollectionReport, getDetailedCollectionLog, listCollectionBatches, listCollectionQa, setCollectionBatchState } from "../../../lib/auto-collector";
import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  const url = new URL(request.url), id = url.searchParams.get("id"), view = url.searchParams.get("view");
  try {
    if (view === "qa") return Response.json(await listCollectionQa({ lote_id: id || "", termo: url.searchParams.get("term") || "", tipo: url.searchParams.get("type") || "", status: url.searchParams.get("status") || "PARA_ANALISE", limite: Number(url.searchParams.get("limit") || 50) }));
    if (view === "detailed-log" && id) return new Response(`\uFEFF${(await getDetailedCollectionLog(id)).conteudo}`, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="LOG-DETALHADO-${id}.txt"`, "cache-control": "no-store" } });
    if (view === "report" && id) return new Response((await getCollectionReport(id)).conteudo, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="RELATORIO-${id}.txt"` } });
    return Response.json(id ? await getCollectionBatch(id) : await listCollectionBatches(50));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try { return Response.json(await createCollectionBatch(await request.json() as Record<string, unknown>), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}

export async function PATCH(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const input = await request.json() as Record<string, unknown>, id = String(input.lote_id || ""), action = String(input.acao || "executar");
    if (action === "executar") return Response.json(await executeCollection({ lote_id: id, max_rodadas: Number(input.max_rodadas) || 1 }));
    if (!["pausar", "retomar", "cancelar"].includes(action)) throw new Error("ACAO_INVALIDA");
    return Response.json(await setCollectionBatchState(id, action as "pausar" | "retomar" | "cancelar"));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}
