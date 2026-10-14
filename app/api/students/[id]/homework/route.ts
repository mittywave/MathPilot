import { requireUser } from "../../../../../lib/server/auth";
import { readStudentHomework } from "../../../../../lib/server/homework";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    return Response.json({ homework: await readStudentHomework(id, user) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "作业记录读取失败" }, { status: 500 });
  }
}
