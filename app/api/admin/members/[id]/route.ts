import { requireSameOrigin } from "../../../../../lib/server/auth";
import { requireAdminUser, updateMember } from "../../../../../lib/server/team";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireAdminUser(request);
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    return Response.json({ member: await updateMember(user, id, body) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "成员更新失败" }, { status: 500 });
  }
}
