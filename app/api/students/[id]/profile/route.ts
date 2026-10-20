import { requireSameOrigin, requireUser } from "../../../../../lib/server/auth";
import { readStudentAbilityAnalysis, readStudentProfile } from "../../../../../lib/server/student-profile";

type RouteContext = { params: Promise<{ id: string }> };

// ?since=<ms> limits both knowledge and ability evidence to recent work.
export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const since = Number(new URL(request.url).searchParams.get("since"));
    return Response.json({ profile: await readStudentProfile(id, user, Number.isFinite(since) && since > 0 ? since : null) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "定档读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const since = Number(new URL(request.url).searchParams.get("since"));
    return Response.json(await readStudentAbilityAnalysis(id, user, Number.isFinite(since) && since > 0 ? since : null, request.signal, new URL(request.url).searchParams.get("refresh") === "1"),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "能力分析失败" }, { status: 500 });
  }
}
