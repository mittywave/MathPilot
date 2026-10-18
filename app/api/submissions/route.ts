import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { countGradingHomework, createAssignedHomework, createCompletedSubmission, readHomeworkProgress, readTeacherSubmissions } from "../../../lib/server/homework";
// Besides the list: ?count=grading for the 学生档案 nav badge, ?progress=students for the badges beside each student.
export async function GET(request: Request) {
  try { const user = await requireUser(request); const query = new URL(request.url).searchParams;
    const result = query.get("count") === "grading" ? { count: await countGradingHomework(user) }
      : query.get("progress") === "students" ? { progress: await readHomeworkProgress(user) } : await readTeacherSubmissions(user, query.get("cursor"));
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { if (error instanceof Response) return error; return Response.json({ error: error instanceof Error ? error.message : "提交记录读取失败" }, { status: 500 }); }
}
// A body with questions assigns a material to students (布置作业); otherwise it starts the upload of a completed homework.
export async function POST(request: Request) {
  try { requireSameOrigin(request); const user = await requireUser(request); const body = await request.json() as { studentId?: string; studentIds?: unknown; title?: string; outputs?: unknown; curriculum?: unknown; groups?: unknown; questions?: unknown; recordId?: unknown; operationId?: unknown };
    if (body.questions !== undefined) return Response.json({ assigned: await createAssignedHomework(body, user) }, { status: 201 });
    return Response.json({ submission: await createCompletedSubmission({ studentId: body.studentId ?? "", title: body.title ?? "", outputs: body.outputs, curriculum: body.curriculum }, user) }, { status: 201 }); }
  catch (error) { if (error instanceof Response) return error; return Response.json({ error: error instanceof Error ? error.message : "提交记录创建失败" }, { status: 500 }); }
}
