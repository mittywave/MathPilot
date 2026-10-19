import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { deletePaperFolder, readPaperFolders, savePaperFolder } from "../../../lib/server/papers";
const failure=(error:unknown)=>error instanceof Response?error:Response.json({error:error instanceof Error?error.message:"目录操作失败"},{status:500});
export async function GET(){try{return Response.json({folders:await readPaperFolders()});}catch(error){return failure(error);}}
export async function POST(request:Request){try{requireSameOrigin(request);await requireUser(request);await savePaperFolder(await request.json());return Response.json({folders:await readPaperFolders()});}catch(error){return failure(error);}}
export const PATCH=POST;
export async function DELETE(request:Request){try{requireSameOrigin(request);const user=await requireUser(request),{id}=await request.json() as {id:string};await deletePaperFolder(user,id);return Response.json({folders:await readPaperFolders()});}catch(error){return failure(error);}}
