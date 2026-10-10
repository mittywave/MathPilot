import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { assertTeacherUploadContext, attachAssignmentAsset, requireHomeworkEnabled, storeHomeworkAsset } from "../../../lib/server/homework-assets";
import type { HomeworkAssetRole } from "../../../lib/types";

// Reference answers belong to the homework; pages and the uploaded PDF belong to one submission.
const ROLES: HomeworkAssetRole[] = ["answer", "submission_original", "submission_document"];

function decodedFileName(request: Request) {
  const value = request.headers.get("X-File-Name") ?? "homework-page.jpg";
  try { return decodeURIComponent(value); } catch { return "homework-page.jpg"; }
}

export async function POST(request: Request) {
  try {
    requireHomeworkEnabled(); requireSameOrigin(request);
    const user = await requireUser(request);
    const url = new URL(request.url); const assignmentId = url.searchParams.get("assignmentId") ?? "";
    const submissionId = url.searchParams.get("submissionId") ?? "";
    const role = url.searchParams.get("role") as HomeworkAssetRole;
    if (!ROLES.includes(role) || (role === "answer") !== Boolean(assignmentId) || (role !== "answer") !== Boolean(submissionId)) {
      return Response.json({ error: "图片类型与上传上下文不匹配" }, { status: 400 });
    }
    await assertTeacherUploadContext(user, { assignmentId: assignmentId || undefined, submissionId: submissionId || undefined });
    const contentType = request.headers.get("Content-Type")?.split(";", 1)[0] ?? "";
    const asset = await storeHomeworkAsset({
      ownerUserId: user.id, bytes: await request.arrayBuffer(), contentType, originalName: decodedFileName(request), role,
      assignmentId: assignmentId || undefined, submissionId: submissionId || undefined,
    });
    if (role === "answer") await attachAssignmentAsset(assignmentId, asset, user);
    return Response.json({ asset }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "作业页面上传失败" }, { status: 500 });
  }
}
