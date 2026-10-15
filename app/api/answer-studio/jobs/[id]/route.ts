import { requireSameOrigin, requireUser } from "../../../../../lib/server/auth";
import { deleteStudioJob, getStudioJobDraft, startStudioJob } from "../../../../../lib/server/answer-studio-jobs";

type RouteContext = { params: Promise<{ id: string }> };
const failure = (error: unknown) => error instanceof Response ? error : Response.json({ error: error instanceof Error ? error.message : "转录任务操作失败" }, { status: 500 });

export async function GET(request: Request, context: RouteContext) {
  try { return Response.json(await getStudioJobDraft(await requireUser(request), (await context.params).id)); } catch (error) { return failure(error); }
}
/** Starts the uploaded job, or continues one that failed. */
export async function POST(request: Request, context: RouteContext) {
  try { requireSameOrigin(request); return Response.json({ job: await startStudioJob(await requireUser(request), (await context.params).id) }); } catch (error) { return failure(error); }
}
export async function DELETE(request: Request, context: RouteContext) {
  try { requireSameOrigin(request); await deleteStudioJob(await requireUser(request), (await context.params).id); return Response.json({ deleted: true }); } catch (error) { return failure(error); }
}
