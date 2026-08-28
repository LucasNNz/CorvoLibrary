import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";
import { getD1ToTursoPreflight, migrateD1ToTurso, rollbackLastD1Migration } from "../../../../lib/d1-to-turso-migration";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    return Response.json(await getD1ToTursoPreflight(), { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers });
  }
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const body = await request.json().catch(() => ({})) as { replaceExisting?: boolean; confirmation?: string };
    if (body.replaceExisting && body.confirmation !== "SUBSTITUIR_TURSO_PELO_D1") {
      return Response.json({ error: "CONFIRMACAO_DE_SUBSTITUICAO_OBRIGATORIA" }, { status: 400, headers });
    }
    return Response.json(await migrateD1ToTurso({ replaceExisting: Boolean(body.replaceExisting) }), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = message === "TURSO_TARGET_HAS_APPLICATION_DATA";
    return Response.json({ error: message }, { status: conflict ? 409 : 500, headers });
  }
}

export async function DELETE(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const body = await request.json().catch(() => ({})) as { confirmation?:string };
    if (body.confirmation !== "RESTAURAR_BACKUP_ANTERIOR") return Response.json({error:"CONFIRMACAO_DE_ROLLBACK_OBRIGATORIA"},{status:400,headers});
    return Response.json(await rollbackLastD1Migration(), { headers });
  } catch (error) {
    return Response.json({ error:error instanceof Error?error.message:String(error) }, { status:500, headers });
  }
}
