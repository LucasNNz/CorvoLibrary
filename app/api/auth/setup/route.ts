import { setupLibraryAuth } from "../../../../lib/auth";
export async function POST(request: Request) {
  try {
    const body = await request.json() as { username?:string; password?:string; remember?:boolean };
    const result = await setupLibraryAuth(String(body.username || ""), String(body.password || ""), body.remember !== false);
    return Response.json({ configured:true, authenticated:true, username:result.username }, { status:201, headers:{"set-cookie":result.cookie,"cache-control":"no-store"} });
  } catch (error) { const message=error instanceof Error?error.message:String(error); return Response.json({error:message},{status:message==="AUTH_ALREADY_CONFIGURED"?409:400}); }
}
