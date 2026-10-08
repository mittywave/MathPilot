import { listMembers, readInvite, requireAdminUser } from "../../../../lib/server/team";

export async function GET(request: Request) {
  try {
    const user = await requireAdminUser(request);
    const [members, invite] = await Promise.all([listMembers(), readInvite()]);
    return Response.json({ members, invite, me: user.id }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "成员读取失败" }, { status: 500 });
  }
}
