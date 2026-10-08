import type { LibraryModule } from "../../../../lib/types";
import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { deleteScopedModule, updateScopedModule } from "../../../../lib/server/library";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const body = await request.json() as { module?: Partial<LibraryModule> };
    return Response.json({ module: await updateScopedModule(id, body.module ?? {}, user) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "模块更新失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { confirmation?: string };
    return Response.json({ ok: true, ...(await deleteScopedModule(id, body.confirmation ?? "", user)) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "模块删除失败" }, { status: 500 });
  }
}
