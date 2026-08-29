import { runDataPlaneRecovery } from '../../../../lib/data-plane';
import { isOwnerRequest } from '../../../../lib/mcp-access';

export const runtime = 'nodejs';
export const maxDuration = 300;

function cronAuthorized(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim() || '';
  return Boolean(cronSecret) && request.headers.get('authorization') === `Bearer ${cronSecret}`;
}

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    return Response.json({ ok: true, ...(await runDataPlaneRecovery(`VERCEL_CRON:${new Date().toISOString()}`)) });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    return Response.json({ ok: true, ...(await runDataPlaneRecovery(`MANUAL_RECOVERY:${new Date().toISOString()}`)) });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
