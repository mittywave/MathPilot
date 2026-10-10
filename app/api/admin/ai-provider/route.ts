import { environmentSummary } from '../../../../lib/server/ai/routing';
import { hasV2Schema } from "../../../../lib/server/ai/provider-repository";
import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { AiProviderInputError, aiProviderEncryptionReady, environmentAiFallbackSummary, getAiProviderConfig, saveAiProviderConfig } from "../../../../lib/server/ai-provider";
import { normalizeAiProviderWireApi } from "../../../../lib/ai-provider-rules.mjs";

async function requireAdmin(request: Request) {
  const user = await requireUser(request);
  if (user.role !== "admin") throw new Response(JSON.stringify({ error: "仅管理员可以配置 AI Provider" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
  return user;
}

function caught(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof AiProviderInputError || error instanceof SyntaxError) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ error: error instanceof Error ? error.message : "AI Provider 操作失败" }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const v2 = await hasV2Schema();
    return Response.json({ config: v2 ? null : await getAiProviderConfig(), environmentFallback: v2 ? environmentSummary() : environmentAiFallbackSummary(), encryptionReady: aiProviderEncryptionReady(), ...(v2 ? { version: 2, settingsUrl: '/settings/ai' } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return caught(error);
  }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin(request);
    if (await hasV2Schema()) return Response.json({ error: "V2 已启用，请使用 /settings/ai；旧接口不可写入或借用旧密钥。", code: "V2_REQUIRED" }, { status: 409 });
    const body = await request.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AiProviderInputError("配置必须是 JSON 对象");
    const modelCatalog = Array.isArray(body.modelCatalog)
      ? body.modelCatalog.map((item) => {
          if (typeof item === "string") return { id: item };
          const value = item as { id?: unknown; displayName?: unknown };
          return { id: typeof value?.id === "string" ? value.id : "", displayName: typeof value?.displayName === "string" ? value.displayName : undefined };
        })
      : [];
    const config = await saveAiProviderConfig({
      name: typeof body.name === "string" ? body.name : "AI Provider",
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      wireApi: normalizeAiProviderWireApi(body.wireApi),
      modelCatalog,
      recognitionModel: typeof body.recognitionModel === "string" ? body.recognitionModel : "",
      textModel: typeof body.textModel === "string" ? body.textModel : "",
      diagramModel: typeof body.diagramModel === "string" ? body.diagramModel : "",
      gradingModel: typeof body.gradingModel === "string" ? body.gradingModel : "",
      enabled: body.enabled !== false,
    });
    return Response.json({ config });
  } catch (error) {
    return caught(error);
  }
}
