import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { countActiveStudioJobs, createStudioJob, listStudioJobs } from "../../../../lib/server/answer-studio-jobs";

const failure = (error: unknown) => error instanceof Response ? error : Response.json({ error: error instanceof Error ? error.message : "转录任务操作失败" }, { status: 500 });

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const query = new URL(request.url).searchParams, kind = query.get("kind");
    return Response.json(query.get("count") === "active" ? { count: await countActiveStudioJobs(user, kind) } : { jobs: await listStudioJobs(user, kind) });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try { requireSameOrigin(request); return Response.json({ job: await createStudioJob(await requireUser(request), await request.json()) }); } catch (error) { return failure(error); }
}
