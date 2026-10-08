import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { arrangeHandouts, createHandout, listHandouts } from "../../../lib/server/handouts";

export async function GET(request: Request) {
  try {
    await requireUser(request);
    return Response.json({ handouts: await listHandouts() });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "讲义列表读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json().catch(() => ({})) as { handout?: unknown };
    return Response.json({ handout: await createHandout(user, body.handout) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "讲义创建失败" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    requireSameOrigin(request);
    await requireUser(request);
    const body = await request.json().catch(() => ({}));
    return Response.json(await arrangeHandouts(body));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "课次调整失败" }, { status: 500 });
  }
}
