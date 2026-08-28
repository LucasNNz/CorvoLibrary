import { completeAutomaticProject, completeAutomaticProjects, createAutomaticProject, deleteAutomaticProjects, getAutomaticProject, getAutomaticProjectLog, getProjectConsistencyGate, listAutomaticProjects, processAutomaticProject, qaAutomaticProject, reconcileAutomaticProject, regenerateProjectZip, reopenAutomaticProject, updateAutomaticProject } from "../../../lib/automatic-projects";
import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";
import { wakeDataPlane } from "../../../lib/data-plane";

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  const url = new URL(request.url), id = url.searchParams.get("id"), view = url.searchParams.get("view");
  try {
    if (id && view === "log") {
      const log = await getAutomaticProjectLog(id);
      return new Response(`\uFEFF${log.conteudo}`, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${log.arquivo}"`, "cache-control": "no-store" } });
    }
    return Response.json(id ? await getAutomaticProject(id) : await listAutomaticProjects(Number(url.searchParams.get("limit") || 50)));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try { const result = await createAutomaticProject(await request.json() as Record<string, unknown>); wakeDataPlane("API_PROJECT_CREATE"); return Response.json(result, { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}

export async function PATCH(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const input = await request.json() as Record<string, unknown>, action = String(input.acao || "processar");
    if (action === "configurar") return Response.json(await updateAutomaticProject(input));
    if (action === "qa") return Response.json(await qaAutomaticProject(input));
    if (action === "zip") return Response.json(await regenerateProjectZip(String(input.projeto_id || "")));
    if (action === "reconciliar") return Response.json(await reconcileAutomaticProject(String(input.projeto_id || "")));
    if (action === "validar") return Response.json(await getProjectConsistencyGate(String(input.projeto_id || "")));
    if (action === "concluir") return Response.json(await completeAutomaticProject(input));
    if (action === "desconcluir") return Response.json(await reopenAutomaticProject({ ...input, confirmar_reabertura: true, origem: "OWNER_UI", motivo: String(input.motivo || "Desconclusão explícita pela interface") }));
    if (action === "concluir_lote") return Response.json(await completeAutomaticProjects(input));
    if (action === "desconcluir_lote") return Response.json(await completeAutomaticProjects({ ...input, concluido: false }));
    const result = await processAutomaticProject(input); wakeDataPlane(`API_PROJECT_PROCESS:${String(input.projeto_id || input.project_id || "")}`); return Response.json(result);
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}

export async function DELETE(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try { return Response.json(await deleteAutomaticProjects(await request.json() as Record<string, unknown>)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}
