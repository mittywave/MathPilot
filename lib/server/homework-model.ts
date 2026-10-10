import { recognitionReasoningEffort } from "./recognition-model-rules.mjs";
import { callStructuredAi, type AiGatewayResult } from "./ai-gateway";

type ModelInput = {
  prompt: string;
  images: string[];
  schema: Record<string, unknown>;
  schemaName: string;
  upperAttempt?: number;
};

export async function callHomeworkModel(input: ModelInput): Promise<AiGatewayResult> {
  return callStructuredAi({
    role: "grading",
    upperAttempt: input.upperAttempt,
    prompt: input.prompt,
    images: input.images,
    schema: input.schema,
    schemaName: input.schemaName,
    reasoningEffort: recognitionReasoningEffort(),
    missingMessage: "尚未配置智能批改",
  });
}

export function parseHomeworkModelText(value: string) {
  return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as unknown;
}
