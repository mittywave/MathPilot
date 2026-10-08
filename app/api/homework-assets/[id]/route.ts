import { currentUser } from "../../../../lib/server/auth";
import { canTeacherReadAsset, homeworkAssetBytes, requireHomeworkEnabled } from "../../../../lib/server/homework-assets";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    requireHomeworkEnabled(); const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
    const user = await currentUser(request);
    if (!user || !await canTeacherReadAsset(id, user)) return new Response("Not found", { status: 404 });
    const asset = await homeworkAssetBytes(id);
    if (!asset) return new Response("Not found", { status: 404 });
    return new Response(asset.bytes, { headers: {
      "Content-Type": asset.contentType, "Content-Length": String(asset.byteSize), "ETag": asset.etag,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response("Asset unavailable", { status: 500 });
  }
}
