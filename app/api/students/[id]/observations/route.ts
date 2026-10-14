import { requireSameOrigin, requireUser } from "../../../../../lib/server/auth";
import { createObservation } from "../../../../../lib/server/student-profile";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    return Response.json(await createObservation(id, user, await request.json()), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "课后反馈保存失败" }, { status: 500 });
  }
}
