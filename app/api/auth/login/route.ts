import { loginLibrary } from "../../../../lib/auth";
export async function POST(request: Request) {
  try {
    const body = await request.json() as { username?:string; password?:string; remember?:boolean };
    const result = await loginLibrary(String(body.username || ""), String(body.password || ""), body.remember !== false);
    return Response.json({ configured:true, authenticated:true, username:result.username }, { headers:{"set-cookie":result.cookie,"cache-control":"no-store"} });
  } catch (error) { const message=error instanceof Error?error.message:String(error); return Response.json({error:message},{status:message==="INVALID_LOGIN"?401:400}); }
}
