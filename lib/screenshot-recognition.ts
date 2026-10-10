import { compressDataUrl, fileToDataUrl, materializeImageDataUrl } from "./image-tools";

// 截图录题和讲义知识点读截图的方式完全相同：同样的大小限制、压缩尺寸和报错文案。
// A sharp copy is kept for cropping figures; the model receives a lighter one.
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;

export async function readScreenshot(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > MAX_SCREENSHOT_BYTES) throw new Error("图片超过 15MB，请先裁剪或压缩");
  try { return await compressDataUrl(await fileToDataUrl(file), 3200); }
  catch { throw new Error("无法读取这张图片，请换一张重试"); }
}

export async function recognizeScreenshot<T>(endpoint: "/api/recognize" | "/api/recognize-note", image: string, fields: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fields, image: await materializeImageDataUrl(image) }) });
  const payload = await response.json().catch(() => ({})) as { result?: T; error?: string; code?: string };
  if (!response.ok || !payload.result) throw new Error(payload.code === "MISSING_API_KEY" ? "智能识别尚未配置。请检查本地 Sub2API 地址、Key 和视觉模型。" : payload.error || "识别失败，请重试");
  return payload.result;
}

// The first image among dropped files; other dragged content is left to the browser.
export function droppedImage(event: { dataTransfer: Pick<DataTransfer, "files"> | null }) {
  return Array.from(event.dataTransfer?.files ?? []).find((file) => file.type.startsWith("image/")) ?? null;
}
