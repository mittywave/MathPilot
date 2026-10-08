import type { Category } from "../../../lib/types";
import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { createScopedCategory } from "../../../lib/server/library";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json() as { category?: Category };
    if (!body.category) return Response.json({ error: "请填写分类名称" }, { status: 400 });
    const category = await createScopedCategory(body.category, user);
    return Response.json({ category }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "分类创建失败" }, { status: 500 });
  }
}
