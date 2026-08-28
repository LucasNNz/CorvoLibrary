import { runDataPlaneRecovery } from '../../../../lib/data-plane';
import { isOwnerRequest } from '../../../../lib/mcp-access';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    return Response.json({ ok: true, ...(await runDataPlaneRecovery(`MANUAL_RECOVERY:${new Date().toISOString()}`)) });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
