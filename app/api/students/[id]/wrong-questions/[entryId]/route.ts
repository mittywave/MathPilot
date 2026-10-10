import { requireSameOrigin, requireUser } from "../../../../../../lib/server/auth";
import { deleteWrongQuestion, restoreWrongQuestion } from "../../../../../../lib/server/student-wrong-book";

type RouteContext = { params: Promise<{ id: string; entryId: string }> };

/** 删除：移入错题本底部的“历史记录”。 */
export async function DELETE(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id, entryId } = await context.params;
    await deleteWrongQuestion(id, entryId, user);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "错题删除失败" }, { status: 500 });
  }
}

/** 从“历史记录”恢复被删除的错题。 */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id, entryId } = await context.params;
    await restoreWrongQuestion(id, entryId, user);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "错题恢复失败" }, { status: 500 });
  }
}
