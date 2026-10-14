import { requireSameOrigin, requireUser } from "../../../../../../lib/server/auth";
import { deleteObservation, updateObservation } from "../../../../../../lib/server/student-profile";

type RouteContext = { params: Promise<{ id: string; observationId: string }> };

export async function PUT(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id, observationId } = await context.params;
    return Response.json(await updateObservation(id, observationId, user, await request.json()));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "课后反馈更新失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id, observationId } = await context.params;
    await deleteObservation(id, observationId, user);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "课后反馈删除失败" }, { status: 500 });
  }
}
