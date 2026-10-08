import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { authorizeQuestionDownload } from "../../../lib/server/library";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json().catch(() => ({})) as { questionIds?: string[] };
    if (!Array.isArray(body.questionIds) || !await authorizeQuestionDownload(user, body.questionIds)) {
      return Response.json({ error: "所选题目不存在或无权下载" }, { status: 403 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "下载授权失败" }, { status: 500 });
  }
}
