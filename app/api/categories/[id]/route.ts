import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { deleteScopedCategory } from "../../../../lib/server/library";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    return Response.json({ ok: true, ...(await deleteScopedCategory(id, user)) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "分类删除失败" }, { status: 500 });
  }
}
