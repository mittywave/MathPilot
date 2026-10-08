import { buildNoteRecognitionPrompt, normalizeNoteRecognitionResult, noteRecognitionSchema } from "../../../lib/recognition-contract";
import { requireSameOrigin, requireUser } from "../../../lib/server/auth";
import { callRecognitionModel, parseRecognitionModelText } from "../../../lib/server/recognition-model";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireUser(request);
    const body = await request.json().catch(() => ({})) as { image?: string };
    if (!body.image?.startsWith("data:image/")) return Response.json({ error: "没有收到有效图片" }, { status: 400 });
    if (body.image.length > 20_000_000) return Response.json({ error: "图片过大，请裁剪后重试" }, { status: 413 });
    const result = await callRecognitionModel({ signal: request.signal, image: body.image, prompt: buildNoteRecognitionPrompt(), schema: noteRecognitionSchema, schemaName: "handout_note_extraction" });
    if (!result.text) return Response.json({ error: result.error || "中转站没有返回可用的识别结果，请检查模型是否支持图片" }, { status: result.status >= 400 ? result.status : 502 });
    try { return Response.json({ result: normalizeNoteRecognitionResult(parseRecognitionModelText(result.text)) }); }
    catch { return Response.json({ error: "中转站返回的内容不是有效结构化数据，请换用支持 JSON Schema 的模型" }, { status: 502 }); }
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "识别失败，请稍后重试" }, { status: 500 });
  }
}
