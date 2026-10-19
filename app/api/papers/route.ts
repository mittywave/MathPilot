import { currentUser, requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { createPaper, listPapers } from "../../../lib/server/papers";
const failure=(error:unknown)=>error instanceof Response?error:Response.json({error:error instanceof Error?error.message:"试卷操作失败"},{status:500});
export async function GET(request:Request){try{const user=await currentUser(request);return Response.json(await listPapers(new URL(request.url).searchParams,user),{headers:{"Cache-Control":"private, no-store"}});}catch(error){return failure(error);}}
export async function POST(request:Request){try{requireSameOrigin(request);return Response.json(await createPaper(await requireUser(request),request),{status:201});}catch(error){return failure(error);}}
