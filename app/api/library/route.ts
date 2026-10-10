import { currentUser } from "../../../lib/server/auth";
import { readLibrary } from "../../../lib/server/library";

export async function GET(request: Request) {
  try {
    return Response.json(await readLibrary(await currentUser(request)), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "题库读取失败" }, { status: 500 });
  }
}
