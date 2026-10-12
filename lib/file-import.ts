import JSZip from "jszip";
import { isDocxOptionBlock, splitDocxOptionBlocks } from "./docx-import-rules.mjs";
import { openPdf } from "./pdfjs";
import { markDocxUnderline } from "./question-presentation-rules.mjs";
import type { QuestionType } from "./types";

export type StructuredDocxQuestion = {
  questionNumber: string;
  type: QuestionType;
  stem: string;
  stemParagraphs: string[];
  stemDocxXml: string[];
  stemDocxAssets: Record<string, string>;
  options: string[];
  optionsDocxXml: string[];
  optionsDocxAssets: Record<string, string>;
  sourcePage: number;
};

export type ImportPage = {
  pageNumber: number;
  image: string;
  textHint?: string;
  documentSection?: "questions" | "answers";
  sourceAnswers?: Record<string, string>;
  sourceAnalyses?: Record<string, string>;
  sourceAnalysisXml?: Record<string, string[]>;
  sourceAnalysisAssets?: Record<string, Record<string, string>>;
  sourceQuestionImages?: Record<string, string[]>;
  sourceOptions?: Record<string, string[]>;
  sourceQuestions?: StructuredDocxQuestion[];
};

const MAX_PAGES = 80;
const MAX_IMAGE_EDGE = 2100;
const EMPTY_PAGE_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

function canvasDataUrl(canvas: HTMLCanvasElement, quality = .9) {
  const longest = Math.max(canvas.width, canvas.height);
  if (longest <= MAX_IMAGE_EDGE) return canvas.toDataURL("image/jpeg", quality);
  const scale = MAX_IMAGE_EDGE / longest;
  const resized = document.createElement("canvas");
  resized.width = Math.round(canvas.width * scale); resized.height = Math.round(canvas.height * scale);
  const context = resized.getContext("2d");
  if (!context) throw new Error("无法生成文件页面图片");
  context.fillStyle = "#fff"; context.fillRect(0, 0, resized.width, resized.height);
  context.drawImage(canvas, 0, 0, resized.width, resized.height);
  return resized.toDataURL("image/jpeg", quality);
}

function childByLocalName(node: Node, name: string) {
  return Array.from(node.childNodes).find((child) => child.localName === name);
}

function wordNodeText(node: Node, preserveUnderlines = false): string {
  const localName = node.localName;
  if (localName === "t") return node.textContent ?? "";
  if (localName === "r") {
    const value = Array.from(node.childNodes).filter((child) => child.localName !== "rPr").map((child) => wordNodeText(child, preserveUnderlines)).join("");
    const runProperties = Array.from(node.childNodes).find((child) => child.localName === "rPr");
    const underline = runProperties ? Array.from(runProperties.childNodes).find((child) => child.localName === "u") as Element | undefined : undefined;
    const underlineValue = underline?.getAttribute("w:val") ?? underline?.getAttribute("val") ?? "single";
    return preserveUnderlines && underline && underlineValue !== "none" ? markDocxUnderline(value) : value;
  }
  if (localName === "oMath") return `$${Array.from(node.childNodes).map((child) => wordNodeText(child, preserveUnderlines)).join("")}$`;
  if (localName === "tc") return Array.from(node.childNodes).map((child) => wordNodeText(child, preserveUnderlines)).join("").trim();
  if (localName === "tr") return Array.from(node.childNodes).filter((child) => child.localName === "tc").map((child) => wordNodeText(child, preserveUnderlines)).join("\t");
  if (localName === "tbl") return Array.from(node.childNodes).filter((child) => child.localName === "tr").map((child) => wordNodeText(child, preserveUnderlines)).join("\n");
  if (localName === "tab") return "\t";
  if (localName === "br" || localName === "cr") return "\n";
  if (localName === "f") {
    const numerator = childByLocalName(node, "num"); const denominator = childByLocalName(node, "den");
    return `\\frac{${numerator ? wordNodeText(numerator, preserveUnderlines) : ""}}{${denominator ? wordNodeText(denominator, preserveUnderlines) : ""}}`;
  }
  if (localName === "rad") { const expression = childByLocalName(node, "e"); return `\\sqrt{${expression ? wordNodeText(expression, preserveUnderlines) : ""}}`; }
  if (localName === "sSup") {
    const base = childByLocalName(node, "e"); const exponent = childByLocalName(node, "sup");
    return `${base ? wordNodeText(base, preserveUnderlines) : ""}^{${exponent ? wordNodeText(exponent, preserveUnderlines) : ""}}`;
  }
  if (localName === "sSub") {
    const base = childByLocalName(node, "e"); const subscript = childByLocalName(node, "sub");
    return `${base ? wordNodeText(base, preserveUnderlines) : ""}_{${subscript ? wordNodeText(subscript, preserveUnderlines) : ""}}`;
  }
  if (localName === "sSubSup") {
    const base = childByLocalName(node, "e"); const subscript = childByLocalName(node, "sub"); const exponent = childByLocalName(node, "sup");
    return `${base ? wordNodeText(base, preserveUnderlines) : ""}_{${subscript ? wordNodeText(subscript, preserveUnderlines) : ""}}^{${exponent ? wordNodeText(exponent, preserveUnderlines) : ""}}`;
  }
  return Array.from(node.childNodes).map((child) => wordNodeText(child, preserveUnderlines)).join("");
}

export function docxStemDisplayText(paragraphXml: string[]) {
  return paragraphXml.map((xml, index) => {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    let value = wordNodeText(document.documentElement, true).trim();
    if (index === 0) value = value.replace(/^\s*\d{1,3}[.．、]\s*/, "");
    return value;
  }).filter((value) => value.length > 0).join("\n");
}

function sectionQuestionType(value: string): QuestionType | null {
  if (/多(?:项)?选择题/.test(value)) return "多选题";
  if (/(?:单项)?选择题/.test(value)) return "单选题";
  if (/填空题/.test(value)) return "填空题";
  if (/判断题/.test(value)) return "判断题";
  if (/(?:解答|证明|计算|综合与实践)题/.test(value)) return "解答题";
  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferFilledAnswer(questionText: string, answeredText: string) {
  const parts = questionText.split(/[\s\u3000]{2,}/).filter((part) => part.length > 0);
  if (parts.length < 2) return "";
  const pattern = parts.map((part) => escapeRegExp(part).replace(/(?:\\ |\s)+/g, "\\s*")).join("([\\s\\S]+?)");
  const match = answeredText.match(new RegExp(`^\\s*${pattern}\\s*$`));
  if (!match) return "";
  return match.slice(1).map((value) => value.trim()).filter(Boolean).join("；");
}

async function extractDocxParagraphs(buffer: ArrayBuffer) {
  const archive = await JSZip.loadAsync(buffer); const xml = await archive.file("word/document.xml")?.async("text");
  if (!xml) return { paragraphs: [] as string[], answerSectionStart: -1, pageCount: 0, answers: {} as Record<string, string>, analyses: {} as Record<string, string>, analysisXml: {} as Record<string, string[]>, analysisAssets: {} as Record<string, Record<string, string>>, questionImages: {} as Record<string, string[]>, options: {} as Record<string, string[]>, questions: [] as StructuredDocxQuestion[] };
  const appXml = await archive.file("docProps/app.xml")?.async("text");
  const pageCount = appXml ? Number(new DOMParser().parseFromString(appXml, "application/xml").getElementsByTagName("Pages")[0]?.textContent ?? 0) : 0;
  const documentXml = new DOMParser().parseFromString(xml, "application/xml");
  const paragraphNodes = Array.from(documentXml.getElementsByTagName("w:p"));
  const paragraphs = paragraphNodes.map((paragraph) => wordNodeText(paragraph).trim());
  const answerSectionStart = paragraphs.findIndex((paragraph) => /(?:参考答案与试题解析|答案与解析|试题解析)/.test(paragraph));
  const body = Array.from(documentXml.getElementsByTagName("w:body"))[0];
  const blockNodes = body ? Array.from(body.childNodes).filter((node) => node.localName === "p" || node.localName === "tbl") : [];
  const blocks = blockNodes.map((node) => ({ text: wordNodeText(node).trim(), xml: new XMLSerializer().serializeToString(node), kind: node.localName as "p" | "tbl" }));
  const answerBlockStart = blocks.findIndex((block) => /(?:参考答案与试题解析|答案与解析|试题解析)/.test(block.text));
  const questionEnd = answerBlockStart < 0 ? blocks.length : answerBlockStart;
  type ParsedQuestion = StructuredDocxQuestion & { firstParagraph: string; blocks: typeof blocks };
  const questions: ParsedQuestion[] = [];
  let currentType: QuestionType | null = null; let currentQuestion: ParsedQuestion | null = null;
  for (let index = 0; index < questionEnd; index += 1) {
    const block = blocks[index]; const detectedType = sectionQuestionType(block.text);
    if (detectedType && /^[一二三四五六七八九十]+[.．、]/.test(block.text)) { currentType = detectedType; currentQuestion = null; continue; }
    if (index > 0 && block.text === blocks[0]?.text) continue;
    const numberMatch = block.kind === "p" ? block.text.match(/^\s*(\d{1,3})[.．、]\s*([\s\S]*)$/) : null;
    if (numberMatch && currentType) {
      const firstParagraph = numberMatch[2].trim();
      currentQuestion = { questionNumber: numberMatch[1], type: currentType, stem: firstParagraph, stemParagraphs: [], stemDocxXml: [], stemDocxAssets: {}, options: [], optionsDocxXml: [], optionsDocxAssets: {}, sourcePage: 0, firstParagraph, blocks: [block] };
      questions.push(currentQuestion); continue;
    }
    if (currentQuestion && (block.text || block.kind === "tbl" || /r:embed="[^"]+"/.test(block.xml))) currentQuestion.blocks.push(block);
  }
  const options: Record<string, string[]> = {};
  for (const question of questions) {
    const optionBlocks = question.type === "单选题" || question.type === "多选题" ? question.blocks.filter((block) => isDocxOptionBlock(block.text)) : [];
    const stemBlocks = question.blocks.filter((block) => !optionBlocks.includes(block));
    question.options = splitDocxOptionBlocks(optionBlocks.map((block) => block.text));
    question.optionsDocxXml = optionBlocks.map((block) => block.xml);
    question.stemParagraphs = stemBlocks.map((block, index) => index === 0 ? block.text.replace(/^\s*\d{1,3}[.．、]\s*/, "") : block.text).filter(Boolean);
    question.stemDocxXml = stemBlocks.map((block) => block.xml);
    question.stem = question.stemParagraphs.join("\n");
    options[question.questionNumber] = question.options;
  }
  const answers: Record<string, string> = {}; const repeatedQuestionText: Record<string, string> = {}; const analysisParts: Record<string, string[]> = {}; const analysisXml: Record<string, string[]> = {}; let currentNumber = ""; let collectingAnalysis = false;
  for (let index = Math.max(0, answerBlockStart); index < blocks.length; index += 1) {
    const block = blocks[index]; const paragraph = block.text;
    const numberMatch = block.kind === "p" ? paragraph.match(/^\s*(\d{1,3})[.．、]\s*([\s\S]*)$/) : null;
    const number = numberMatch?.[1];
    if (number) { currentNumber = number; collectingAnalysis = false; repeatedQuestionText[number] = numberMatch?.[2].trim() ?? ""; }
    const choice = paragraph.match(/(?:故选|答案(?:为)?)[：:]?\s*([A-F])(?=[。．，、\s]|$)/i)?.[1].toUpperCase();
    if (currentNumber && choice) answers[currentNumber] = choice;
    if (/^【(?:分析|解答|点评)】/.test(paragraph)) collectingAnalysis = true;
    if (currentNumber && collectingAnalysis) {
      (analysisXml[currentNumber] ??= []).push(block.xml);
      if (paragraph) (analysisParts[currentNumber] ??= []).push(paragraph);
      if (/^【点评】/.test(paragraph)) collectingAnalysis = false;
    }
  }
  const imageAssets: Record<string, string> = {};
  const relationshipsXml = await archive.file("word/_rels/document.xml.rels")?.async("text");
  if (relationshipsXml) {
    const relationships = new DOMParser().parseFromString(relationshipsXml, "application/xml");
    const imageRelationships = Array.from(relationships.getElementsByTagName("Relationship")).filter((relationship) => relationship.getAttribute("Type")?.endsWith("/image"));
    await Promise.all(imageRelationships.map(async (relationship) => {
      const id = relationship.getAttribute("Id"); const target = relationship.getAttribute("Target");
      if (!id || !target) return;
      const path = target.startsWith("/") ? target.slice(1) : `word/${target}`.split("/").reduce<string[]>((parts, part) => { if (part === "..") parts.pop(); else if (part !== ".") parts.push(part); return parts; }, []).join("/");
      const asset = archive.file(path); if (!asset) return;
      const extension = path.split(".").pop()?.toLowerCase() ?? "png";
      const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "gif" ? "image/gif" : "image/png";
      imageAssets[id] = `data:${mime};base64,${await asset.async("base64")}`;
    }));
  }
  const analysisAssets = Object.fromEntries(Object.entries(analysisXml).map(([number, items]) => {
    const ids = new Set(items.flatMap((item) => Array.from(item.matchAll(/r:embed="([^"]+)"/g), (match) => match[1])));
    return [number, Object.fromEntries(Array.from(ids).flatMap((id) => imageAssets[id] ? [[id, imageAssets[id]]] : []))];
  }));
  for (const question of questions) {
    const ids = new Set(question.stemDocxXml.flatMap((item) => Array.from(item.matchAll(/r:embed="([^"]+)"/g), (match) => match[1])));
    question.stemDocxAssets = Object.fromEntries(Array.from(ids).flatMap((id) => imageAssets[id] ? [[id, imageAssets[id]]] : []));
    const optionIds = new Set(question.optionsDocxXml.flatMap((item) => Array.from(item.matchAll(/r:embed="([^"]+)"/g), (match) => match[1])));
    question.optionsDocxAssets = Object.fromEntries(Array.from(optionIds).flatMap((id) => imageAssets[id] ? [[id, imageAssets[id]]] : []));
  }
  const questionImages = Object.fromEntries(questions.map((question) => {
    const ids = Array.from(new Set([...question.stemDocxXml, ...question.optionsDocxXml].flatMap((item) => Array.from(item.matchAll(/r:embed="([^"]+)"/g), (match) => match[1]))));
    return [question.questionNumber, ids.flatMap((id) => imageAssets[id] ? [imageAssets[id]] : [])];
  }));
  const analyses = Object.fromEntries(Object.entries(analysisParts).map(([number, parts]) => [number, parts.join("\n")]));
  for (const question of questions) {
    if (!answers[question.questionNumber] && question.type === "填空题") {
      const inferred = inferFilledAnswer(question.firstParagraph, repeatedQuestionText[question.questionNumber] ?? "");
      if (inferred) answers[question.questionNumber] = inferred;
    }
    if (!answers[question.questionNumber] && question.type === "解答题" && analyses[question.questionNumber]) answers[question.questionNumber] = "见解析";
  }
  return { paragraphs, answerSectionStart, pageCount, answers, analyses, analysisXml, analysisAssets, questionImages, options, questions: questions.map((question) => ({ questionNumber: question.questionNumber, type: question.type, stem: question.stem, stemParagraphs: question.stemParagraphs, stemDocxXml: question.stemDocxXml, stemDocxAssets: question.stemDocxAssets, options: question.options, optionsDocxXml: question.optionsDocxXml, optionsDocxAssets: question.optionsDocxAssets, sourcePage: question.sourcePage })) };
}

async function renderPdf(file: File, onProgress: (current: number, total: number) => void): Promise<ImportPage[]> {
  const loadingTask = await openPdf(new Uint8Array(await file.arrayBuffer())); const pdf = await loadingTask.promise;
  if (pdf.numPages > MAX_PAGES) throw new Error(`文件共有 ${pdf.numPages} 页，当前一次最多导入 ${MAX_PAGES} 页`);
  const pages: ImportPage[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber); const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, MAX_IMAGE_EDGE / Math.max(base.width, base.height)); const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false }); if (!context) throw new Error("无法读取 PDF 页面");
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    pages.push({ pageNumber, image: canvasDataUrl(canvas) }); onProgress(pageNumber, pdf.numPages);
    page.cleanup();
  }
  await loadingTask.destroy(); return pages;
}

function waitForImages(root: HTMLElement) {
  return Promise.all(Array.from(root.querySelectorAll("img")).map((image) => image.complete ? Promise.resolve() : new Promise<void>((resolve) => { image.onload = () => resolve(); image.onerror = () => resolve(); })));
}

async function renderDocx(file: File, onProgress: (current: number, total: number) => void): Promise<ImportPage[]> {
  const buffer = await file.arrayBuffer();
  const sourceDocument = await extractDocxParagraphs(buffer);
  if (sourceDocument.questions.length) {
    const totalPages = sourceDocument.pageCount || 1;
    if (totalPages > MAX_PAGES) throw new Error(`文件共有约 ${totalPages} 页，当前一次最多导入 ${MAX_PAGES} 页`);
    onProgress(totalPages, totalPages);
    return [{ pageNumber: 1, image: EMPTY_PAGE_IMAGE, sourceAnswers: sourceDocument.answers, sourceAnalyses: sourceDocument.analyses, sourceAnalysisXml: sourceDocument.analysisXml, sourceAnalysisAssets: sourceDocument.analysisAssets, sourceQuestionImages: sourceDocument.questionImages, sourceOptions: sourceDocument.options, sourceQuestions: sourceDocument.questions }];
  }
  const [{ renderAsync }, html2canvasModule] = await Promise.all([import("docx-preview"), import("html2canvas")]);
  const html2canvas = html2canvasModule.default;
  const host = document.createElement("div"); host.className = "file-import-render-host";
  Object.assign(host.style, { position: "fixed", left: "-12000px", top: "0", width: "900px", background: "white", zIndex: "-1" });
  document.body.appendChild(host);
  try {
    await renderAsync(buffer, host, undefined, { className: "docx", inWrapper: true, breakPages: true, ignoreWidth: false, ignoreHeight: false, renderHeaders: true, renderFooters: true, useBase64URL: true });
    await waitForImages(host); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const renderedPages = Array.from(host.querySelectorAll<HTMLElement>("section.docx"));
    const targets = renderedPages.length ? renderedPages : [host];
    const renderedCanvases: Array<{ canvas: HTMLCanvasElement; target: HTMLElement }> = [];
    for (let index = 0; index < targets.length; index += 1) {
      const canvas = await html2canvas(targets[index], { backgroundColor: "#ffffff", scale: 1.7, logging: false, useCORS: true });
      renderedCanvases.push({ canvas, target: targets[index] });
    }
    let answerSectionSeen = false;
    const pageSlices = renderedCanvases.flatMap(({ canvas, target }) => {
      const a4Height = Math.round(canvas.width * 297 / 210);
      const sliceCount = Math.ceil(canvas.height / a4Height); const hints = Array.from({ length: sliceCount }, () => [] as string[]); const answerFlags = Array.from({ length: sliceCount }, () => false);
      const targetRect = target.getBoundingClientRect(); const scale = canvas.width / Math.max(1, targetRect.width);
      const paragraphs = Array.from(target.querySelectorAll<HTMLElement>("article p"));
      for (const paragraph of paragraphs) {
        const hint = paragraph.textContent?.trim() ?? "";
        if (!hint) continue;
        const top = Math.max(0, (paragraph.getBoundingClientRect().top - targetRect.top) * scale);
        const sliceIndex = Math.min(sliceCount - 1, Math.floor(top / a4Height)); hints[sliceIndex].push(hint);
        if (/(?:参考答案与试题解析|答案与解析|试题解析)/.test(hint)) answerSectionSeen = true;
        if (answerSectionSeen) answerFlags[sliceIndex] = true;
      }
      const slices: Array<{ canvas: HTMLCanvasElement; textHint: string; documentSection: "questions" | "answers" }> = [];
      for (let top = 0; top < canvas.height; top += a4Height) {
        const height = Math.min(a4Height, canvas.height - top);
        const pageCanvas = document.createElement("canvas"); pageCanvas.width = canvas.width; pageCanvas.height = height;
        const context = pageCanvas.getContext("2d", { alpha: false }); if (!context) throw new Error("无法分页 Word 文档");
        context.fillStyle = "#fff"; context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        context.drawImage(canvas, 0, top, canvas.width, height, 0, 0, canvas.width, height);
        const sliceIndex = slices.length;
        slices.push({ canvas: pageCanvas, textHint: hints[sliceIndex].join("\n"), documentSection: answerFlags[sliceIndex] ? "answers" : "questions" });
      }
      return slices;
    });
    if (pageSlices.length > MAX_PAGES) throw new Error(`文件共有约 ${pageSlices.length} 页，当前一次最多导入 ${MAX_PAGES} 页`);
    const pages: ImportPage[] = [];
    for (let index = 0; index < pageSlices.length; index += 1) {
      pages.push({ pageNumber: index + 1, image: canvasDataUrl(pageSlices[index].canvas), textHint: pageSlices[index].textHint, documentSection: pageSlices[index].documentSection, sourceAnswers: sourceDocument.answers, sourceAnalyses: sourceDocument.analyses, sourceAnalysisXml: sourceDocument.analysisXml, sourceAnalysisAssets: sourceDocument.analysisAssets, sourceQuestionImages: sourceDocument.questionImages, sourceOptions: sourceDocument.options, sourceQuestions: sourceDocument.questions }); onProgress(index + 1, pageSlices.length);
    }
    return pages;
  } finally { host.remove(); }
}

// A question read from the Word document's own structure: stem, options, figures, and the answer and analysis
// the document's answer section gives for its number. 录入 and 排版 both build on this.
export function structuredDocxQuestions(pages: ImportPage[]) {
  const page = pages.find((item) => item.sourceQuestions?.length);
  return (page?.sourceQuestions ?? []).map((item) => ({
    questionNumber: item.questionNumber, type: item.type, sourcePage: item.sourcePage,
    stem: item.stem, stemParagraphs: item.stemParagraphs, stemDocxXml: item.stemDocxXml, stemDocxAssets: item.stemDocxAssets,
    options: item.options, optionsDocxXml: item.optionsDocxXml, optionsDocxAssets: item.optionsDocxAssets,
    answer: page?.sourceAnswers?.[item.questionNumber] ?? (item.type === "解答题" ? "见解析" : ""),
    analysis: page?.sourceAnalyses?.[item.questionNumber] ?? "", analysisDocxXml: page?.sourceAnalysisXml?.[item.questionNumber], analysisDocxAssets: page?.sourceAnalysisAssets?.[item.questionNumber],
    contentImages: page?.sourceQuestionImages?.[item.questionNumber] ?? [],
  }));
}

export async function renderImportFile(file: File, onProgress: (current: number, total: number) => void): Promise<ImportPage[]> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pdf" || file.type === "application/pdf") return renderPdf(file, onProgress);
  if (extension === "docx" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return renderDocx(file, onProgress);
  if (extension === "doc") throw new Error("暂不支持旧版 .doc，请在 Word 中另存为 .docx 后导入");
  throw new Error("请选择 PDF 或 .docx 文件");
}
