import { currentUser, requireSameOrigin } from "../../../lib/server/auth";
import { currentStudent } from "../../../lib/server/homework-auth";
import { assertStudentUploadContext, assertTeacherUploadContext, attachAssignmentAsset, requireHomeworkEnabled, storeHomeworkAsset } from "../../../lib/server/homework-assets";
import type { HomeworkAssetRole } from "../../../lib/types";

const ROLES: HomeworkAssetRole[] = ["question", "answer", "submission_original", "submission_processed", "submission_document", "answer_crop"];

function decodedFileName(request: Request) {
  const value = request.headers.get("X-File-Name") ?? "homework-page.jpg";
  try { return decodeURIComponent(value); } catch { return "homework-page.jpg"; }
}

export async function POST(request: Request) {
  try {
    requireHomeworkEnabled(); requireSameOrigin(request);
    const url = new URL(request.url); const assignmentId = url.searchParams.get("assignmentId") ?? "";
    const submissionId = url.searchParams.get("submissionId") ?? "";
    const rawRole = url.searchParams.get("role") as HomeworkAssetRole;
    const role = ROLES.includes(rawRole) ? rawRole : "submission_original";
    const pageOrder = Math.max(0, Math.min(200, Number(url.searchParams.get("pageOrder")) || 0));
    const user = await currentUser(request); const student = await currentStudent(request);
    if (!user && !student) return Response.json({ error: "请先登录" }, { status: 401 });
    let studentUpload = false;
    if (student && submissionId && ["submission_original", "submission_processed", "submission_document"].includes(role)) {
      try { await assertStudentUploadContext(student, submissionId); studentUpload = true; }
      catch (error) { if (!user) throw error; }
    }
    if (!studentUpload) {
      if (!user) return Response.json({ error: "学生只能上传自己的答卷页面" }, { status: 403 });
      if ((role === "question" || role === "answer") !== Boolean(assignmentId) || (role === "submission_original" || role === "submission_processed" || role === "submission_document") !== Boolean(submissionId)) {
        return Response.json({ error: "图片类型与上传上下文不匹配" }, { status: 400 });
      }
      if (role === "answer_crop") return Response.json({ error: "错题截图只能由批改流程生成" }, { status: 403 });
      await assertTeacherUploadContext(user, { assignmentId: assignmentId || undefined, submissionId: submissionId || undefined });
    }
    const contentType = request.headers.get("Content-Type")?.split(";", 1)[0] ?? "";
    const asset = await storeHomeworkAsset({
      ownerUserId: studentUpload ? student!.ownerUserId : user!.id,
      bytes: await request.arrayBuffer(), contentType,
      originalName: decodedFileName(request), role, pageOrder,
      assignmentId: assignmentId || undefined, submissionId: submissionId || undefined, studentId: studentUpload ? student!.studentId : undefined,
    });
    if (!studentUpload && user && assignmentId && (role === "question" || role === "answer")) await attachAssignmentAsset(assignmentId, asset, user);
    return Response.json({ asset }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "作业页面上传失败" }, { status: 500 });
  }
}
