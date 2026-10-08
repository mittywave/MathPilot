import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { deleteHandout, getHandout, updateHandout } from "../../../../lib/server/handouts";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    await requireUser(request);
    const { id } = await context.params;
    return Response.json({ handout: await getHandout(id) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "讲义读取失败" }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    await requireUser(request);
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { handout?: unknown };
    return Response.json({ handout: await updateHandout(id, body.handout) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "讲义保存失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    await deleteHandout(user, id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "讲义删除失败" }, { status: 500 });
  }
}
