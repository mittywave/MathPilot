import { requireUser } from "../../../lib/server/auth";
import { readWrongQuestionCatalog } from "../../../lib/server/student-wrong-book";

/** 学生错题本里还没进题库的题，供题库页搜索。 */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return Response.json({ items: await readWrongQuestionCatalog(user) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "错题读取失败" }, { status: 500 });
  }
}
