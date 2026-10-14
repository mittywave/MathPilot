import { requireSameOrigin, requireUser } from "../../../../../lib/server/auth";
import { createStudentReport, listStudentReports } from "../../../../../lib/server/student-profile";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    return Response.json({ reports: await listStudentReports(id, user) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "学情报告读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    return Response.json(await createStudentReport(id, user, await request.json()), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "学情报告生成失败" }, { status: 500 });
  }
}
