import { recognitionReasoningEffort } from "./recognition-model-rules.mjs";
import { callStructuredAi, type AiGatewayResult } from "./ai-gateway";
import { aiTimeoutMs } from "./ai-http";

type RecognitionModelInput = {
  role?: "recognition" | "diagram";
  prompt: string;
  image?: string;
  images?: string[];
  schema: Record<string, unknown>;
  schemaName: string;
  signal?: AbortSignal;
};

export async function callRecognitionModel(input: RecognitionModelInput): Promise<AiGatewayResult> {
  return callStructuredAi({
    role: input.role || "recognition",
    signal: input.signal,
    timeoutMs: aiTimeoutMs(process.env.RECOGNITION_TIMEOUT_MS || process.env.AI_REQUEST_TIMEOUT_MS, 180_000),
    prompt: input.prompt,
    images: input.images ?? (input.image ? [input.image] : []),
    schema: input.schema,
    schemaName: input.schemaName,
    reasoningEffort: recognitionReasoningEffort(),
    missingMessage: "尚未配置智能识别",
    // Answer Studio owns retry/backoff. Authentication, rate limits and timeouts
    // should remain single-protocol failures, but generic 5xx/protocol errors may
    // indicate an incompatible wire API and are allowed to try the next adapter.
    stopAutoFallbackStatuses: input.schemaName.startsWith("teacher_")
      ? [401, 403, 408, 429]
      : [],
  });
}

export function parseRecognitionModelText(text: string) {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as unknown;
}
