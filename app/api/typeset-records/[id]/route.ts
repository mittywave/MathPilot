import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { deleteTypesetRecord, updateTypesetRecord } from "../../../../lib/server/typeset-records";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    return Response.json({ record: await updateTypesetRecord(user, id, await request.json().catch(() => ({}))) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "历史记录保存失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    await deleteTypesetRecord(user, id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "历史记录删除失败" }, { status: 500 });
  }
}
