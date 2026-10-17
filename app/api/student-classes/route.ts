import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { deleteStudentClass, saveStudentClass } from "../../../lib/server/student-wrong-book";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json() as { name?: unknown; studentIds?: unknown };
    return Response.json({ name: await saveStudentClass(body, user) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "班级创建失败" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json() as { name?: unknown; studentIds?: unknown; previousName?: unknown };
    if (typeof body.previousName !== "string") return Response.json({ error: "请选择班级" }, { status: 400 });
    return Response.json({ name: await saveStudentClass(body, user, body.previousName) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "班级保存失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json() as { name?: unknown };
    if (typeof body.name !== "string") return Response.json({ error: "请选择班级" }, { status: 400 });
    await deleteStudentClass(body.name, user);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "班级删除失败" }, { status: 500 });
  }
}
