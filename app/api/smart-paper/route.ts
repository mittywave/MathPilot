import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { generateSmartPaper } from "../../../lib/server/smart-paper";

// 智能组卷: { request, studentId?, current?, instruction? } → { plan, exclude }. With current and instruction the plan is revised.
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    return Response.json(await generateSmartPaper(user, await request.json().catch(() => ({})), request.signal));
  } catch (error) {
    if (error instanceof Response) return error;
    if (request.signal.aborted) return Response.json({ error: "请求已取消" }, { status: 499 });
    return Response.json({ error: error instanceof Error ? error.message : "智能组卷失败，请稍后重试" }, { status: 500 });
  }
}
