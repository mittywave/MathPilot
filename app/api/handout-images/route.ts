import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { storeUserImage } from "../../../lib/server/library";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json().catch(() => ({})) as { image?: unknown };
    if (typeof body.image !== "string") return Response.json({ error: "没有收到有效图片" }, { status: 400 });
    return Response.json({ url: await storeUserImage(body.image, user) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "图片保存失败" }, { status: 500 });
  }
}
