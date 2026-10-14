import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { deleteHandoutCourse, saveHandoutCourse } from "../../../lib/server/handouts";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireUser(request);
    return Response.json(await saveHandoutCourse(await request.json().catch(() => ({}))));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "大纲保存失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json().catch(() => ({})) as { id?: unknown };
    return Response.json(await deleteHandoutCourse(user, body.id));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "大纲删除失败" }, { status: 500 });
  }
}
