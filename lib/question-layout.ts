import type { ImageLayout, Question } from "./types";
import { automaticQuestionImageLayout, isCompactConclusionChoice } from "./question-presentation-rules.mjs";

const geometrySignals = /(?:△|∠|三角形|四边形|平行四边形|梯形|菱形|正方形|长方形|圆|弧|切线|弦|几何|全等|相似|勾股|线段|垂直|平行)/;

export function questionImages(question: Question) {
  const images = [...(question.contentImages ?? []), ...(question.diagramImage ? [question.diagramImage] : [])];
  const optionImages = new Set(question.optionsDocxXml?.length ? Object.values(question.optionsDocxAssets ?? {}) : []);
  const stemImages = new Set(Object.values(question.stemDocxAssets ?? {}));
  return images.filter((image, index) => images.indexOf(image) === index && (!optionImages.has(image) || stemImages.has(image)));
}

export function isGeometryQuestion(question: Question) {
  const context = `${question.stem} ${(question.tags ?? []).join(" ")}`;
  return questionImages(question).length === 1 && geometrySignals.test(context);
}

export function isCompactConclusionQuestion(question: Question) {
  return isCompactConclusionChoice({
    type: question.type,
    stem: question.stem,
    imageCount: questionImages(question).length,
    optionCount: question.options.length,
  });
}

// A screenshot question keeps its figure where the original printed it: beside the text when the figure starts in the
// right half of the screenshot, otherwise under the text, at the same share of the line width.
function screenshotFigureBox(question: Question) {
  return question.originalImage && question.diagramBox && questionImages(question).length === 1 ? question.diagramBox : null;
}

export function sourceFigureWidth(question: Question, forPrint = false) {
  const box = screenshotFigureBox(question);
  // A crop's share of a photographed page is not a readable print size. Keep
  // the web's source proportions, but give standalone print figures 40% of a line.
  if (forPrint && questionImages(question).length === 1) return Math.min(1, Math.max(.4, (box?.width ?? 0) / 1000));
  return box ? Math.min(1, Math.max(.12, box.width / 1000)) : null;
}

export function resolveQuestionImageLayout(question: Question): ImageLayout {
  const imageCount = questionImages(question).length;
  const paragraphCount = question.stemParagraphs?.filter((paragraph) => paragraph.trim()).length ?? question.stem.split(/\r?\n/).filter((paragraph) => paragraph.trim()).length;
  const compactConclusion = isCompactConclusionQuestion(question);
  const automaticLayout = automaticQuestionImageLayout({ imageCount, stemLength: question.stem.length, paragraphCount, type: question.type, stem: question.stem, optionCount: question.options.length });
  if (compactConclusion) return "below";
  const screenshotFigure = screenshotFigureBox(question);
  if (screenshotFigure) return screenshotFigure.x < 450 ? "below" : "right";
  if (automaticLayout && (question.stemDocxXml?.length || !question.imageLayout)) return automaticLayout;
  if (isGeometryQuestion(question)) return "right";
  return question.imageLayout ?? automaticLayout ?? "right";
}
