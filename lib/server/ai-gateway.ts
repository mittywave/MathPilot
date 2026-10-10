import { hasV2Schema } from './ai/provider-repository';
import { callV2 } from './ai/engine';
import {
  aiProviderAutoProtocolOrder,
  normalizeAiProviderApiBase,
  shouldTryAlternateAiProtocol,
  type AiProviderRole,
  type AiProviderWireApi,
} from "../ai-provider-rules.mjs";
import { callAntigravityGemini, type AntigravityResult } from "./antigravity-gemini";
import { resolveAiRuntime, type AiRuntime } from "./ai-provider";
import { aiFetch, aiTimeoutMs, AiTimeoutError, readAiBody, withAiDeadline } from "./ai-http";
import { matchesAiSchema } from "./ai-schema";

export type StructuredAiInput = {
  role: AiProviderRole;
  prompt: string;
  images?: string[];
  schema: Record<string, unknown>;
  schemaName: string;
  reasoningEffort?: string;
  missingMessage?: string;
  stopAutoFallbackStatuses?: number[];
  signal?: AbortSignal;
  timeoutMs?: number;
  upperAttempt?: number;
};
export type AiGatewayResult = AntigravityResult & { terminal?: boolean; code?: string; attempts?: number; fallbackUsed?: boolean; diagnosticId?: string };
type ConcreteWireApi = Exclude<AiProviderWireApi, "auto">;
type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
function partsText(parts: unknown, type: string) {
  return (Array.isArray(parts) ? parts : [])
    .map(asObject).filter(part => part.type === type && typeof part.text === "string")
    .map(part => part.text).join("");
}
function responseOutput(payload: JsonObject) {
  const blocks = (Array.isArray(payload.output) ? payload.output : []).map(asObject)
    .flatMap(item => Array.isArray(item.content) ? item.content : []);
  return {
    text: typeof payload.output_text === "string" && payload.output_text.trim() ? payload.output_text : partsText(blocks, "output_text"),
    terminal: payload.status === "incomplete" || payload.status === "failed" || blocks.some(part => asObject(part).type === "refusal"),
  };
}
function chatOutput(payload: JsonObject) {
  const choice = asObject(Array.isArray(payload.choices) ? payload.choices[0] : undefined);
  const message = asObject(choice.message);
  return {
    text: typeof message.content === "string" ? message.content : partsText(message.content, "text"),
    terminal: Boolean(message.refusal) || choice.finish_reason === "length" || choice.finish_reason === "content_filter",
  };
}
function unsupported(message: string) {
  return /unsupported|not supported|does not support|not support|unknown (?:parameter|field)|unrecognized (?:parameter|field)|not allowed|不支持/i.test(message);
}
function endpointUnsupported(result: AiGatewayResult) {
  return [404, 405, 501].includes(result.status) ||
    [400, 422].includes(result.status) && unsupported(result.error || "") && /responses|endpoint/i.test(result.error || "");
}

async function callOpenAi(protocol: "responses" | "chat_completions", runtime: AiRuntime, input: StructuredAiInput): Promise<AiGatewayResult> {
  let reasoning = true, format = 0;
  // Each rejected optional capability is removed at most once, only on an
  // explicit unsupported-parameter error. Auth/model/schema/rate errors stop.
  for (let attempt = 0; attempt < 4; attempt++) {
    input.signal?.throwIfAborted();
    const prompt = format > 0
      ? `${input.prompt}\n\nReturn ONLY a JSON value conforming to this schema (no Markdown):\n${JSON.stringify(input.schema)}`
      : input.prompt;
    const responses = protocol === "responses";
    const content: JsonObject[] = [{ type: responses ? "input_text" : "text", text: prompt }];
    for (const image of input.images ?? []) content.push(responses
      ? { type: "input_image", image_url: image, detail: "high" }
      : { type: "image_url", image_url: { url: image, detail: "high" } });
    const schema = { name: input.schemaName, strict: true, schema: input.schema };
    const body: JsonObject = responses
      ? { model: runtime.model, store: false, input: [{ role: "user", content }] }
      : { model: runtime.model, messages: [{ role: "user", content }] };
    if (reasoning) body[responses ? "reasoning" : "reasoning_effort"] = responses ? { effort: input.reasoningEffort || "high" } : input.reasoningEffort || "high";
    if (format < 2) {
      if (responses) body.text = { format: format === 0 ? { type: "json_schema", ...schema } : { type: "json_object" } };
      else body.response_format = format === 0 ? { type: "json_schema", json_schema: schema } : { type: "json_object" };
    }
    const response = await aiFetch(`${normalizeAiProviderApiBase(runtime.baseUrl)}/${responses ? "responses" : "chat/completions"}`, {
      method: "POST", signal: input.signal,
      headers: { Authorization: `Bearer ${runtime.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const retryAfter = response.headers.get("retry-after");
    const raw = await readAiBody(response);
    let payload: JsonObject;
    try { payload = asObject(JSON.parse(raw)); }
    catch { return { status: response.ok ? 502 : response.status, retryAfter, error: `上游返回非 JSON 响应（HTTP ${response.status}）` }; }
    const error = asObject(payload.error);
    const message = typeof error.message === "string" ? error.message : `${protocol} 请求失败（${response.status}）`;
    if (!response.ok || payload.error) {
      const rejected = `${message} ${typeof error.param === "string" ? error.param : ""}`;
      if (!retryAfter && [400, 422].includes(response.status) && unsupported(rejected)) {
        if (reasoning && /reasoning(?:[_. ]effort)?/i.test(rejected)) { reasoning = false; continue; }
        if (format < 2 && /response_format|text\.format|json_schema|json_object|structured (?:output|response)|strict/i.test(rejected)) { format++; continue; }
      }
      const terminal = [400, 422].includes(response.status) && !endpointUnsupported({ status: response.status, error: message });
      return { status: response.ok ? 502 : response.status, retryAfter, error: message, terminal };
    }
    const output = responses ? responseOutput(payload) : chatOutput(payload);
    if (output.terminal) return { status: 422, retryAfter, terminal: true, error: "上游拒绝请求或输出未完成，未自动重复计费请求" };
    if (!output.text.trim()) return { status: 502, retryAfter, error: "上游返回成功状态，但没有可用正文" };
    if (format > 0) {
      try {
        const parsed = JSON.parse(output.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
        if (!matchesAiSchema(parsed, input.schema)) throw new Error("schema mismatch");
        return { status: response.status, retryAfter, text: JSON.stringify(parsed) };
      } catch { return { status: 422, retryAfter, terminal: true, error: "兼容模式输出不符合题库数据结构，已拒绝使用" }; }
    }
    return { status: response.status, retryAfter, text: output.text };
  }
  return { status: 422, terminal: true, error: "上游不支持所需的结构化输出参数" };
}
async function callProtocol(protocol: ConcreteWireApi, runtime: AiRuntime, input: StructuredAiInput): Promise<AiGatewayResult> {
  if (protocol !== "antigravity_gemini") return callOpenAi(protocol, runtime, input);
  const result = await callAntigravityGemini(runtime.baseUrl, runtime.apiKey, runtime.model, input.prompt,
    input.images ?? [], input.schema, input.reasoningEffort || "high", input.signal);
  return result.status < 400 && !result.text?.trim()
    ? { ...result, status: 502, error: result.error || "Antigravity 没有返回可用正文" } : result;
}
// Remember endpoint capability, NEVER prompts, images, model output or raw keys.
const capabilities = new Map<string, { protocol: ConcreteWireApi; until: number }>();
async function capabilityKey(runtime: AiRuntime) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runtime.apiKey));
  return `${normalizeAiProviderApiBase(runtime.baseUrl)}|${runtime.model}|${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function callConfigured(runtime: AiRuntime, input: StructuredAiInput): Promise<AiGatewayResult> {
  if (runtime.wireApi !== "auto") return callProtocol(runtime.wireApi, runtime, input);
  const key = await capabilityKey(runtime), cached = capabilities.get(key);
  const order = aiProviderAutoProtocolOrder(runtime.model);
  if (cached && cached.until > Date.now()) order.sort((a, b) => Number(b === cached.protocol) - Number(a === cached.protocol));
  else capabilities.delete(key);
  let unsupportedEndpoint = false;
  let result: AiGatewayResult = { status: 502, error: "AI Provider 没有返回结果" };
  for (const protocol of order) {
    input.signal?.throwIfAborted();
    result = await callProtocol(protocol, runtime, input);
    if (result.text?.trim() && result.status < 400) {
      if (unsupportedEndpoint) {
        if (capabilities.size >= 32) capabilities.delete(capabilities.keys().next().value!);
        capabilities.set(key, { protocol, until: Date.now() + 10 * 60_000 });
      }
      return result;
    }
    if (result.terminal || (input.stopAutoFallbackStatuses ?? []).includes(result.status) || !shouldTryAlternateAiProtocol(result)) return result;
    if (endpointUnsupported(result)) {
      unsupportedEndpoint = true;
      if (cached?.protocol === protocol) capabilities.delete(key);
    }
  }
  return result;
}
export async function callStructuredAi(input: StructuredAiInput): Promise<AiGatewayResult> {
  if (await hasV2Schema()) return callV2(input);
  input.signal?.throwIfAborted();
  const runtime = await resolveAiRuntime(input.role);
  if (!runtime) return { status: 503, terminal: true, error: input.missingMessage || "尚未配置 AI Provider" };
  try {
    const result = await withAiDeadline(signal => callConfigured(runtime, { ...input, signal }),
      aiTimeoutMs(input.timeoutMs ?? process.env.AI_REQUEST_TIMEOUT_MS, 180_000), input.signal);
    if (result.error) result.error = result.error.split(runtime.apiKey).join("[redacted]");
    return result;
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    if (error instanceof AiTimeoutError) return { status: 504, retryAfter: null, error: error.message };
    // A transport exception may follow a billed request; don't silently retry it.
    return { status: 502, error: error instanceof Error ? error.message.split(runtime.apiKey).join("[redacted]") : "AI 上游网络请求失败" };
  }
}
