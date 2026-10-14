import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { createAssignedHomework, createCompletedSubmission, readTeacherSubmissions } from "../../../lib/server/homework";
export async function GET(request: Request) {
  try { const user = await requireUser(request);
    return Response.json({ submissions: await readTeacherSubmissions(user) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { if (error instanceof Response) return error; return Response.json({ error: error instanceof Error ? error.message : "提交记录读取失败" }, { status: 500 }); }
}
// A body with questions assigns a material to students (布置作业); otherwise it starts the upload of a completed homework.
export async function POST(request: Request) {
  try { requireSameOrigin(request); const user = await requireUser(request); const body = await request.json() as { studentId?: string; studentIds?: unknown; title?: string; outputs?: unknown; curriculum?: unknown; groups?: unknown; questions?: unknown; start?: unknown; recordId?: unknown };
    if (body.questions !== undefined) return Response.json({ assigned: await createAssignedHomework(body, user) }, { status: 201 });
    return Response.json({ submission: await createCompletedSubmission({ studentId: body.studentId ?? "", title: body.title ?? "", outputs: body.outputs, curriculum: body.curriculum }, user) }, { status: 201 }); }
  catch (error) { if (error instanceof Response) return error; return Response.json({ error: error instanceof Error ? error.message : "提交记录创建失败" }, { status: 500 }); }
}
