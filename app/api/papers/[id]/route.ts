import { currentUser, requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { deletePaper, paperRow, paperJobOwner, paperSource, readPaper, readPaperDraft, updatePaper } from "../../../../lib/server/papers";
import { addStudioJobPage } from "../../../../lib/server/answer-studio-jobs";
type Context={params:Promise<{id:string}>};
const failure=(error:unknown)=>error instanceof Response?error:Response.json({error:error instanceof Error?error.message:"试卷操作失败"},{status:500});
export async function GET(request:Request,context:Context){try{const id=(await context.params).id,query=new URL(request.url).searchParams;if(query.has("source")){await requireUser(request);return await paperSource(id);}if(query.has("draft")){await requireUser(request);return Response.json({draft:await readPaperDraft(id)});}return Response.json({paper:await readPaper(id,await currentUser(request))},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return failure(error);}}
export async function PATCH(request:Request,context:Context){try{requireSameOrigin(request);await requireUser(request);await updatePaper((await context.params).id,await request.json());return Response.json({saved:true});}catch(error){return failure(error);}}
export async function DELETE(request:Request,context:Context){try{requireSameOrigin(request);await deletePaper(await requireUser(request),(await context.params).id);return Response.json({deleted:true});}catch(error){return failure(error);}}
// Shared paper uploads can be completed by another teacher; private recognition jobs remain owner-only.
export async function POST(request:Request,context:Context){try{requireSameOrigin(request);await requireUser(request);const row=await paperRow((await context.params).id);return Response.json({job:await addStudioJobPage(await paperJobOwner(row),row.job_id!,await request.json())});}catch(error){return failure(error);}}
