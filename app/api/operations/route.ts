import { exportOperationsText, getManagementDashboard, getOperationalDashboard } from "../../../lib/worker-orchestration";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const view = (url.searchParams.get("view") || "operational").toLowerCase();
  const format = (url.searchParams.get("format") || "json").toLowerCase();
  try {
    if (format === "txt") {
      const payload = await exportOperationsText(view === "management" ? "management" : "operational");
      return new Response(payload.conteudo_txt, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="corvo-${view === "management" ? "gerencial" : "operacional"}.txt"` } });
    }
    const data = view === "management" ? await getManagementDashboard(Number(url.searchParams.get("days")) || 30) : await getOperationalDashboard();
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
