import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { readTeacherSubmission, updateSubmission } from "../../../../lib/server/homework";
import type { GradingItem } from "../../../../lib/types";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try { const user = await requireUser(request); const { id } = await context.params; return Response.json({ submission: await readTeacherSubmission(id, user) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { if (error instanceof Response) return error; return Response.json({ error: error instanceof Error ? error.message : "提交记录读取失败" }, { status: 500 }); }
}
export async function PUT(request: Request, context: Context) {
  try { requireSameOrigin(request); const user = await requireUser(request); const { id } = await context.params; const body = await request.json() as {
      action?: string; pages?: Array<{ assetId: string; replacePageId?: string }>; items?: Array<Partial<GradingItem> & { id: string }>; start?: string; profile?: boolean;
    }; return Response.json({ submission: await updateSubmission(id, body, user) }); }
  catch (error) { if (error instanceof Response) return error; return Response.json({ error: error instanceof Error ? error.message : "提交记录更新失败" }, { status: 500 }); }
}
