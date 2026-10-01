import { cleanRecognizedAnalysis, cleanRecognizedAnswer } from "./recognition-cleanup.mjs";
import type { AssignmentQuestion, Question, QuestionType } from "./types";

export const QUESTION_CONTENT_TYPES: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];

// Scanning and homework extraction share the same content contract. Workflow
// metadata (page numbers, confidence, grading) belongs to their own adapters.
export const questionContentSchema = {
  type: { type: "string", enum: QUESTION_CONTENT_TYPES },
  stem: { type: "string" }, options: { type: "array", items: { type: "string" } },
  answer: { type: "string" }, analysis: { type: "string" },
};

export function normalizeQuestionContent(raw: Record<string, unknown>): Pick<Question, "type" | "stem" | "options" | "answer" | "analysis"> {
  const type = QUESTION_CONTENT_TYPES.includes(raw.type as QuestionType) ? raw.type as QuestionType : "解答题";
  const text = (value: unknown, limit = 100_000) => typeof value === "string" ? value.trim().slice(0, limit) : "";
  // Only duplicate labelled source entries are redundant. Unlabelled options
  // may already be normalized, so equal text must keep its answer positions.
  const labelledOptions = new Set<string>();
  const options = (type === "单选题" || type === "多选题") && Array.isArray(raw.options)
    ? raw.options.map((option) => text(option, 2_000)).filter((option) => {
      if (!option) return false;
      if (!/^[A-F][.．、:：]/i.test(option)) return true;
      if (labelledOptions.has(option)) return false;
      labelledOptions.add(option); return true;
    }).slice(0, 12).map((option) => option.replace(/^\s*[A-F][.．、:：]\s*/i, ""))
    : [];
  return { type, stem: text(raw.stem), options, answer: cleanRecognizedAnswer(raw.answer), analysis: cleanRecognizedAnalysis(raw.analysis) };
}

export function assignmentQuestionToQuestion(template: AssignmentQuestion, source: { title: string; createdAt: number; updatedAt: number; originalImage?: string }): Question {
  return {
    ...normalizeQuestionContent(template), id: template.id, categoryId: "homework", difficulty: "中等", provenance: "来源待核实",
    source: source.title, tags: [...template.knowledgeTags], taxonomyKeys: [...template.taxonomyKeys],
    sourcePage: template.pageNumber, originalImage: source.originalImage,
    recognitionConfidence: template.confidence, recognitionWarnings: [...template.warnings],
    createdAt: source.createdAt, updatedAt: source.updatedAt,
  };
}
