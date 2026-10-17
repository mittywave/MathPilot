import { currentUser } from "../../../lib/server/auth";
import { hashText, readLibrary } from "../../../lib/server/library";

export async function GET(request: Request) {
  try {
    const body = JSON.stringify(await readLibrary(await currentUser(request)));
    // The library runs to several megabytes. A browser that already holds this exact copy is told so (304) and uses it,
    // which spares colleagues on the office network the download each time they open 题库 or 学生档案.
    const headers = { "Cache-Control": "private, no-cache", ETag: `"${await hashText(body)}"` };
    if (request.headers.get("If-None-Match")?.split(/\s*,\s*/).includes(headers.ETag)) return new Response(null, { status: 304, headers });
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "题库读取失败" }, { status: 500 });
  }
}
