import { requireSameOrigin } from "../../../../lib/server/auth";
import { changeInvite, requireAdminUser } from "../../../../lib/server/team";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdminUser(request);
    const body = await request.json().catch(() => ({})) as { action?: unknown };
    return Response.json({ invite: await changeInvite(body.action) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "邀请码更新失败" }, { status: 500 });
  }
}
