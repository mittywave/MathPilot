import { requireSameOrigin, requireUser } from "../../../../../../lib/server/auth";
import { deleteStudentReport, updateStudentReport } from "../../../../../../lib/server/student-profile";

type RouteContext = { params: Promise<{ id: string; reportId: string }> };

export async function PUT(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id, reportId } = await context.params;
    return Response.json({ report: await updateStudentReport(id, reportId, user, await request.json()) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "学情报告保存失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id, reportId } = await context.params;
    await deleteStudentReport(id, reportId, user);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "学情报告删除失败" }, { status: 500 });
  }
}
