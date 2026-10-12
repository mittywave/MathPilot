import { requireUser } from "../../../../../lib/server/auth";
import { readTypesetSource } from "../../../../../lib/server/typeset-records";

type RouteContext = { params: Promise<{ id: string }> };

// The record's Word file, for its owner only.
export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const source = await readTypesetSource(user, id);
    return new Response(source.bytes, { headers: {
      "Content-Type": source.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(source.fileName)}`,
    } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "Word 读取失败" }, { status: 500 });
  }
}
