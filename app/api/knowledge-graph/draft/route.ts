import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { discardKnowledgeGraphDraft, readKnowledgeGraphEditor, saveKnowledgeGraphDraft } from "../../../../lib/server/knowledge-graph";

function failure(error: unknown, fallback: string) {
  if (error instanceof Response) return error;
  return Response.json({ error: error instanceof Error ? error.message : fallback }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return Response.json(await readKnowledgeGraphEditor(user), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error, "图谱草稿读取失败"); }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json() as { revision?: unknown; document?: unknown };
    return Response.json(await saveKnowledgeGraphDraft(user, body));
  } catch (error) { return failure(error, "图谱草稿保存失败"); }
}

export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json().catch(() => ({})) as { revision?: unknown };
    return Response.json(await discardKnowledgeGraphDraft(user, body));
  } catch (error) { return failure(error, "放弃草稿失败"); }
}
