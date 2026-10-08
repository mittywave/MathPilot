import { cleanRecognizedAnalysis, cleanRecognizedAnswer } from "./recognition-cleanup.mjs";
import { bareOptionLabels } from "./homework-figures";
import { repairMathSource } from './math-source.mjs';
import { normalizeMathNotation } from './math-notation.mjs';
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
  const content = normalizeQuestionContent({...template,stem:normalizeMathNotation(repairMathSource(template.stem))}); const figures = template.figures ?? [];
  // Section headings and the printed major number are provenance, not the stem
  // of the individually collected sub-question. Its own (1)/(2) stays editable.
  content.stem = content.stem.replace(/^\s*[A-DＡ-Ｄ]\s*组\s*(?:基础夯实|基础巩固|思想方法|综合提升|能力提升)(?:\s*\r?\n|\s+(?=\d{1,3}[.．、]))/, "");
  const printed = template.questionNumber?.match(/^(?:\d+-)?(\d+)(?:\(|$)/)?.[1];
  if (printed) content.stem = content.stem.replace(new RegExp(`^\\s*${printed}[.．、]\\s*`), "");
  // Option graphs are one figure carrying their letters, shown where the options go, so bare letters are not repeated
  // as text options. Wide figures (number lines, long grids) sit under the stem, as on the page, instead of beside it.
  const optionFigure = figures.find((figure) => figure.kind === "options"); const stemFigures = figures.filter((figure) => figure !== optionFigure);
  const below = stemFigures.some((figure) => figure.width && figure.height && figure.width / figure.height >= 2.2);
  return {
    ...content, options: optionFigure && bareOptionLabels(content.options) ? [] : content.options,
    ...(optionFigure ? { optionsImage: optionFigure.url } : {}),
    ...(stemFigures.length ? { contentImages: stemFigures.map((figure) => figure.url), imageLayout: below ? "below" as const : undefined } : {}),
    id: template.id, categoryId: "homework", difficulty: "中等", provenance: "来源待核实",
    source: source.title, tags: [...template.knowledgeTags], taxonomyKeys: [...template.taxonomyKeys],
    sourcePage: template.pageNumber, originalImage: source.originalImage,
    recognitionConfidence: template.confidence, recognitionWarnings: [...template.warnings, ...(figures.some(figure=>figure.hasHandwriting) ? ["配图说明：原卷图内含手写标注，已忠实保留，请结合原卷核对。"] : [])],
    createdAt: source.createdAt, updatedAt: source.updatedAt,
  };
}
