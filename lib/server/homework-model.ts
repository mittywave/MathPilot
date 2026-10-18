import { recognitionReasoningEffort } from "./recognition-model-rules.mjs";
import { callStructuredAi, type AiGatewayResult } from "./ai-gateway";
import { homeworkGradingSignal } from "./homework";

type ModelInput = {
  prompt: string;
  images: string[];
  schema: Record<string, unknown>;
  schemaName: string;
  upperAttempt?: number;
};

export async function callHomeworkModel(input: ModelInput): Promise<AiGatewayResult> {
  const signal = homeworkGradingSignal();
  signal?.throwIfAborted();
  const result = await callStructuredAi({
    signal,
    role: "grading",
    upperAttempt: input.upperAttempt,
    prompt: input.prompt,
    images: input.images,
    schema: input.schema,
    schemaName: input.schemaName,
    reasoningEffort: recognitionReasoningEffort(),
    missingMessage: "尚未配置智能批改",
  });
  signal?.throwIfAborted();
  return result;
}

export function parseHomeworkModelText(value: string) {
  return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as unknown;
}
