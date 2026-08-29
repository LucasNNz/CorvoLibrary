import { getLibrarySession } from "../../../../lib/auth";
import { getDatabaseBootstrapState } from "../../../../lib/platform/database-bootstrap";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const bootstrap = getDatabaseBootstrapState();
  if (!bootstrap.ready) {
    return Response.json({
      configured: false,
      authenticated: false,
      username: "",
      bootstrapRequired: true,
      bootstrap: {
        provider: bootstrap.provider,
        missing: bootstrap.missing,
        marketplaceUrl: bootstrap.marketplaceUrl,
        error: "DATABASE_NOT_CONNECTED",
      },
    }, { headers: { "cache-control": "no-store" } });
  }

  try {
    const session = await getLibrarySession(request);
    return Response.json({
      ...session,
      bootstrapRequired: false,
      bootstrap: { provider: bootstrap.provider, missing: [], marketplaceUrl: bootstrap.marketplaceUrl },
      productionBootstrap: { status: "MIGRATED_DATABASE_REQUIRED", mode: "READ_ONLY_STATUS" },
    }, { headers:{"cache-control":"no-store"} });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const databaseFailure = /TURSO|LIBSQL|DATABASE|SQLITE|VERCEL_ENV_REQUIRED/i.test(raw);
    if (databaseFailure) {
      return Response.json({
        configured: false,
        authenticated: false,
        username: "",
        bootstrapRequired: true,
        bootstrap: {
          provider: bootstrap.provider,
          missing: [],
          marketplaceUrl: bootstrap.marketplaceUrl,
          error: "DATABASE_CONNECTION_FAILED",
          details: raw,
        },
      }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    return Response.json({ error: "AUTO_PRODUCTION_BOOTSTRAP_FAILED", details: raw }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
