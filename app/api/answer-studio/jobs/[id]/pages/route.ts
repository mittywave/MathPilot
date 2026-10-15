import { requireSameOrigin, requireUser } from "../../../../../../lib/server/auth";
import { addStudioJobPage } from "../../../../../../lib/server/answer-studio-jobs";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    return Response.json({ job: await addStudioJobPage(await requireUser(request), (await context.params).id, await request.json()) });
  } catch (error) {
    return error instanceof Response ? error : Response.json({ error: error instanceof Error ? error.message : "页面上传失败" }, { status: 500 });
  }
}
