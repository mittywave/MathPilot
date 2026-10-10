import { requireSameOrigin, requireUser } from "../../../../../lib/server/auth";
import { readWrongQuestions } from "../../../../../lib/server/student-wrong-book";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    return Response.json({ entries: await readWrongQuestions(id, user, new URL(request.url).searchParams.get("includeHistory") === "true") }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "错题记录读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireUser(request);
    return Response.json({ error: "错题由作业批改自动归档，请上传学生作业" }, { status: 410 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "错题记录失败" }, { status: 500 });
  }
}
