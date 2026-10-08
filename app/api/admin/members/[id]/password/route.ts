import { requireSameOrigin } from "../../../../../../lib/server/auth";
import { requireAdminUser, resetMemberPassword } from "../../../../../../lib/server/team";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireAdminUser(request);
    const { id } = await context.params;
    return Response.json({ password: await resetMemberPassword(user, id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "密码重置失败" }, { status: 500 });
  }
}
