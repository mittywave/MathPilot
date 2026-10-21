import type { HTMLAttributes, ReactNode } from "react";
import { DocxContent, DocxOptions } from "./DocxContent";
import { docxWebImageSources, parseDocxWebContent } from "../../lib/docx-web-content";
import { isCompactConclusionQuestion, questionImages, resolveQuestionImageLayout, sourceFigureWidth } from "../../lib/question-layout";
import type { Question } from "../../lib/types";

// Stem, options and figures exactly as the library cards show them.
export function QuestionBody({ question, number, figureAlt = "题目配图" }: { question: Question; number: number | string; figureAlt?: string }) {
  const embeddedImages = new Set(docxWebImageSources(parseDocxWebContent(question.stemDocxXml ?? [], { pictures: true }).blocks, question.stemDocxAssets));
  const images = questionImages(question).filter((image) => !embeddedImages.has(image)); const imageLayout = resolveQuestionImageLayout(question); const compactConclusion = isCompactConclusionQuestion(question);
  const optionsBelow = compactConclusion || imageLayout !== "right";
  const figureWidth = imageLayout === "below" && !compactConclusion ? sourceFigureWidth(question) : null;
  return <div className={`question-presentation ${images.length ? `with-images layout-${imageLayout}${compactConclusion ? " compact-conclusion" : ""}` : ""}`}>
    <div className="question-copy">
      <div className="stem"><b className="question-number">{number}.</b><div className="stem-body">{question.source && <span className="question-source">（{question.source}）</span>}<DocxContent xml={question.stemDocxXml} fallback={question.stem} assets={question.stemDocxAssets} stripLeadingQuestionNumber /></div></div>
      {!optionsBelow && <DocxOptions xml={question.optionsDocxXml} fallback={question.options} assets={question.optionsDocxAssets} />}
    </div>
    {!!images.length && <div className={`question-images ${images.length > 1 ? "multiple" : ""} ${figureWidth ? "source-width" : ""}`} style={figureWidth ? { width: `${figureWidth * 100}%` } : undefined}>{images.map((image, imageIndex) =>
      // eslint-disable-next-line @next/next/no-img-element
      <img className="question-diagram" src={image} alt={`${figureAlt} ${imageIndex + 1}`} key={`${question.id}-image-${imageIndex}`} />
    )}</div>}
    {optionsBelow && <DocxOptions xml={question.optionsDocxXml} fallback={question.options} assets={question.optionsDocxAssets} />}
    {question.optionsImage && <img className="question-options-figure" src={question.optionsImage} alt={`${figureAlt}（选项）`} />}
  </div>;
}

// Quizzes, homework and practice papers share the same numbered row and action line.
export function SheetQuestion({ question, number, grip, metadata, loading = false, children, ...props }: HTMLAttributes<HTMLElement> & { question?: Question; loading?: boolean; number: string | number; grip: ReactNode; metadata: ReactNode; children: ReactNode }) {
  return <article {...props} tabIndex={-1} className={`handout-question${props.className ? ` ${props.className}` : ""}`}>
    {grip}
    {question ? <QuestionBody question={question} number={number} /> : <p className="handout-missing">{loading ? "正在读取题目…" : "原题已删除或无权访问，可替换或移出。"}</p>}
    <div className="handout-question-foot">{metadata}{children}</div>
  </article>;
}
