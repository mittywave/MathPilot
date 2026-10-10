import { hasV2Schema } from "../../../../../lib/server/ai/provider-repository";
import { AiTimeoutError } from "../../../../../lib/server/ai-http";
import { requireSameOrigin, requireUser } from "../../../../../lib/server/auth";
import { AiProviderInputError, discoverAiProviderModels } from "../../../../../lib/server/ai-provider";

async function requireAdmin(request: Request) {
  const user = await requireUser(request);
  if (user.role !== "admin") throw new Response(JSON.stringify({ error: "仅管理员可以获取 AI 模型目录" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin(request);
    if (await hasV2Schema()) return Response.json({ error: "V2 已启用，请使用 /settings/ai；旧接口不可写入或借用旧密钥。", code: "V2_REQUIRED" }, { status: 409 });
    const body = await request.json() as { baseUrl?: string; apiKey?: string; wireApi?: string };
    if (!body || typeof body !== "object" || Array.isArray(body) || [body.baseUrl, body.apiKey, body.wireApi].some(value => value !== undefined && typeof value !== "string")) {
      throw new AiProviderInputError("模型目录参数必须是字符串");
    }
    return Response.json(await discoverAiProviderModels({ ...body, signal: request.signal }));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof AiProviderInputError || error instanceof SyntaxError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof AiTimeoutError) return Response.json({ error: error.message }, { status: 504 });
    if (request.signal.aborted) return Response.json({ error: "请求已取消" }, { status: 499 });
    return Response.json({ error: error instanceof Error ? error.message : "获取上游模型失败" }, { status: 502 });
  }
}
