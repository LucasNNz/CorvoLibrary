import { setupLibraryAuth } from "../../../../lib/auth";
import { getDatabaseBootstrapState } from "../../../../lib/platform/database-bootstrap";

export async function POST(request: Request) {
  const bootstrap = getDatabaseBootstrapState();
  if (!bootstrap.ready) {
    return Response.json({
      error: "DATABASE_BOOTSTRAP_REQUIRED",
      missing: bootstrap.missing,
      marketplaceUrl: bootstrap.marketplaceUrl,
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  try {
    const body = await request.json() as { username?:string; password?:string; remember?:boolean };
    const result = await setupLibraryAuth(String(body.username || ""), String(body.password || ""), body.remember !== false);
    return Response.json({ configured:true, authenticated:true, username:result.username }, { status:201, headers:{"set-cookie":result.cookie,"cache-control":"no-store"} });
  } catch (error) {
    const message=error instanceof Error?error.message:String(error);
    const databaseFailure = /TURSO|LIBSQL|DATABASE|SQLITE|VERCEL_ENV_REQUIRED/i.test(message);
    return Response.json({error: databaseFailure ? "DATABASE_CONNECTION_FAILED" : message},{status:databaseFailure ? 503 : message==="AUTH_ALREADY_CONFIGURED"?409:400});
  }
}
