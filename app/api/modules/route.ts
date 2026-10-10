import type { LibraryModule } from "../../../lib/types";
import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { createScopedModule, reorderScopedModules } from "../../../lib/server/library";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json() as { module?: Partial<LibraryModule>; order?: string[] };
    if (Array.isArray(body.order)) {
      await reorderScopedModules(body.order, user);
      return Response.json({ ok: true });
    }
    return Response.json({ module: await createScopedModule(body.module ?? {}, user) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "模块创建失败" }, { status: 500 });
  }
}
