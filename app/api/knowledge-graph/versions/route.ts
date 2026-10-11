import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { readKnowledgeGraphVersions, restoreKnowledgeGraphVersion } from "../../../../lib/server/knowledge-graph";

function failure(error: unknown, fallback: string) {
  if (error instanceof Response) return error;
  return Response.json({ error: error instanceof Error ? error.message : fallback }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return Response.json({ versions: await readKnowledgeGraphVersions(user, new URL(request.url).searchParams.get("graph")) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error, "版本记录读取失败"); }
}

// Loads an earlier version into the draft; nothing changes until it is published.
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json() as { graph?: unknown; version?: unknown; revision?: unknown };
    return Response.json(await restoreKnowledgeGraphVersion(user, body));
  } catch (error) { return failure(error, "载入历史版本失败"); }
}
