import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { createStudent, readStudents, readStudentClasses } from "../../../lib/server/student-wrong-book";
import type { Student } from "../../../lib/types";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const [students, classes] = await Promise.all([readStudents(user), readStudentClasses(user)]);
    return Response.json({ students, classes }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "学生档案读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json() as { student?: Partial<Student> };
    return Response.json({ student: await createStudent(body.student ?? {}, user) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "学生档案创建失败" }, { status: 500 });
  }
}
