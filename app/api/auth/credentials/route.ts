import { changeLibraryCredentials } from "../../../../lib/auth";
export async function PUT(request: Request) {
  try {
    const body = await request.json() as { currentPassword?:string; username?:string; newPassword?:string; remember?:boolean };
    const result = await changeLibraryCredentials(request, String(body.currentPassword||""), String(body.username||""), String(body.newPassword||""), body.remember !== false);
    return Response.json({ok:true,username:result.username},{headers:{"set-cookie":result.cookie,"cache-control":"no-store"}});
  } catch (error) { const message=error instanceof Error?error.message:String(error); return Response.json({error:message},{status:message==="UNAUTHORIZED"?401:message==="CURRENT_PASSWORD_INVALID"?403:400}); }
}
