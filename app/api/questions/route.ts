import type { Question } from "../../../lib/types";
import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { createScopedQuestion, readDeletedQuestions } from "../../../lib/server/library";

/** 回收站：已删除、可恢复的试题。 */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return Response.json({ questions: await readDeletedQuestions(user) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "回收站读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json() as { question?: Question };
    if (!body.question?.stem?.trim() || !body.question.categoryId) return Response.json({ error: "请填写题干并选择分类" }, { status: 400 });
    const question = await createScopedQuestion(body.question, user);
    return Response.json({ question }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "试题保存失败" }, { status: 500 });
  }
}
