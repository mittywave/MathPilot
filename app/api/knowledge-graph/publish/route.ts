import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { publishKnowledgeGraph } from "../../../../lib/server/knowledge-graph";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json() as { revision?: unknown; note?: unknown };
    return Response.json(await publishKnowledgeGraph(user, body));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "知识图谱发布失败" }, { status: 500 });
  }
}
