import { requireUser } from "../../../lib/server/auth";
import { readTeacherKnowledgeGraph } from "../../../lib/server/homework-capabilities";
import { loadPublishedKnowledgeGraph, readKnowledgeGraphCoverage } from "../../../lib/server/knowledge-graph";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const studentId = new URL(request.url).searchParams.get("studentId") ?? "";
    const graph = await loadPublishedKnowledgeGraph();
    const [profile, coverage] = await Promise.all([readTeacherKnowledgeGraph(user, studentId, graph), readKnowledgeGraphCoverage(graph)]);
    return Response.json({
      profile, coverage, permissions: { canEdit: Boolean(user.local) },
      graph: { graphId: graph.graphId, version: graph.version, frameworkVersion: graph.frameworkVersion, publishedAt: graph.publishedAt, note: graph.note, document: graph.document },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "知识图谱读取失败" }, { status: 500 });
  }
}
