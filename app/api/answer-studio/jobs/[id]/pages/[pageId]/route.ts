import { requireUser } from "../../../../../../../lib/server/auth";
import { studioJobPageImage } from "../../../../../../../lib/server/answer-studio-jobs";

type RouteContext = { params: Promise<{ id: string; pageId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id, pageId } = await context.params;
    return await studioJobPageImage(await requireUser(request), id, pageId);
  } catch (error) {
    return error instanceof Response ? error : Response.json({ error: error instanceof Error ? error.message : "原件读取失败" }, { status: 500 });
  }
}
