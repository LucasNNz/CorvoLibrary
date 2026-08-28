import { getLibrarySession } from "../../../../lib/auth";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return Response.json(await getLibrarySession(request), { headers:{"cache-control":"no-store"} }); }
