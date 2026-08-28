import { clearSessionCookieHeader, logoutLibrary } from "../../../../lib/auth";
export async function POST(request: Request) { await logoutLibrary(request); return Response.json({ok:true},{headers:{"set-cookie":clearSessionCookieHeader(),"cache-control":"no-store"}}); }
