import JSZip from "jszip";
import { docxInferredQuestionType, docxQuestionHeading, docxStudioRole, docxTitleLine, docxVmlPicturesToDrawing, isDocxOptionBlock, splitDocxOptionBlocks } from "./docx-import-rules.mjs";
import { docxMathLatex } from "./docx-web-content";
import { openPdf } from "./pdfjs";
import { readScreenshot } from "./screenshot-recognition";
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
  // What the question itself carries, so questions sharing a number never take each other's figures or answers.
  contentImages: string[];
  warnings: string[];
  answer?: string;
  analysis?: string;
  analysisDocxXml?: string[];
  analysisDocxAssets?: Record<string, string>;
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
  // What the page renderer could not carry from the Word file into the page images.
  renderNotes?: string[];
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
  // VML pictures are read as ordinary inline pictures; ids continue past any the document already uses.
  let pictureId = 10000;
  const blocks = blockNodes.map((node) => {
    const picture = docxVmlPicturesToDrawing(new XMLSerializer().serializeToString(node), pictureId); pictureId += picture.pictures;
    return { text: wordNodeText(node).trim(), xml: picture.xml, kind: node.localName as "p" | "tbl", overlays: picture.overlays };
  });
  const answerBlockStart = blocks.findIndex((block) => /(?:参考答案与试题解析|答案与解析|试题解析)/.test(block.text));
  const questionEnd = answerBlockStart < 0 ? blocks.length : answerBlockStart;
  type ParsedQuestion = StructuredDocxQuestion & { firstParagraph: string; blocks: typeof blocks; heading: boolean };
  const questions: ParsedQuestion[] = [];
  const parsedQuestion = (questionNumber: string, type: QuestionType, firstParagraph: string, heading: boolean, first: typeof blocks): ParsedQuestion => ({ questionNumber, type, stem: firstParagraph, stemParagraphs: [], stemDocxXml: [], stemDocxAssets: {}, options: [], optionsDocxXml: [], optionsDocxAssets: {}, sourcePage: 0, contentImages: [], warnings: [], firstParagraph, blocks: first, heading });
  let currentType: QuestionType | null = null; let currentQuestion: ParsedQuestion | null = null;
  for (let index = 0; index < questionEnd; index += 1) {
    const block = blocks[index];
    // A 讲义 heading (“例题精练 1”) opens a question whose stem is in the paragraphs below it.
    const heading = block.kind === "p" ? docxQuestionHeading(block.text, block.xml) : null;
    if (heading) { currentQuestion = parsedQuestion(`${heading.label} ${heading.number}`, "解答题", "", true, []); questions.push(currentQuestion); continue; }
    const detectedType = sectionQuestionType(block.text);
    if (detectedType && /^[一二三四五六七八九十]+[.．、]/.test(block.text)) { currentType = detectedType; currentQuestion = null; continue; }
    if (index > 0 && block.text === blocks[0]?.text) continue;
    if (currentQuestion?.heading && block.kind === "p" && docxTitleLine(block.text, block.xml)) { currentQuestion = null; continue; }
    const numberMatch = block.kind === "p" && !currentQuestion?.heading ? block.text.match(/^\s*(\d{1,3})(?:[．、]|\.(?!\d))\s*([\s\S]*)$/) : null;
    if (numberMatch && currentType) {
      currentQuestion = parsedQuestion(numberMatch[1], currentType, numberMatch[2].trim(), false, [block]);
      questions.push(currentQuestion); continue;
    }
    if (currentQuestion && (block.text || block.kind === "tbl" || /r:embed="[^"]+"/.test(block.xml))) currentQuestion.blocks.push(block);
  }
  const options: Record<string, string[]> = {};
  for (const question of questions) {
    let questionBlocks = question.blocks;
    if (question.heading) {
      // 文件转录's solution paragraphs (and the figures after them) are the analysis; its notes become warnings.
      const roles = question.blocks.map((block) => docxStudioRole(block.text, block.xml));
      const solutionStart = roles.indexOf("analysis");
      const analysisBlocks = solutionStart < 0 ? [] : question.blocks.filter((_, index) => index >= solutionStart && roles[index] !== "warning");
      questionBlocks = question.blocks.filter((block, index) => roles[index] !== "warning" && !analysisBlocks.includes(block));
      question.warnings.push(...question.blocks.filter((_, index) => roles[index] === "warning").map((block) => block.text.replace(/^(?:转录提示|格式问题)[：:]\s*/, "")));
      const optionCount = questionBlocks.filter((block) => isDocxOptionBlock(block.text)).length;
      question.type = docxInferredQuestionType(questionBlocks, optionCount);
      question.warnings.unshift("题型按内容推断，请核对");
      if (analysisBlocks.length) {
        question.analysis = analysisBlocks.map((block) => block.text).filter(Boolean).join("\n");
        question.analysisDocxXml = analysisBlocks.map((block) => block.xml);
        question.answer = question.type === "解答题" ? "见解析" : question.analysis.match(/(?:故选|答案(?:为)?)[：:]?\s*([A-F])(?=[。．，、\s]|$)/i)?.[1].toUpperCase() ?? "";
      }
    }
    if (question.blocks.some((block) => block.overlays)) question.warnings.push("配图上用 Word 绘制的线条或标注未能读取，只保留了底图，请对照原件核对");
    const optionBlocks = question.type === "单选题" || question.type === "多选题" ? questionBlocks.filter((block) => isDocxOptionBlock(block.text)) : [];
    const stemBlocks = questionBlocks.filter((block) => !optionBlocks.includes(block));
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
    // A line beginning with a decimal (0.71x...) continues the current answer,
    // not a new question 0; the same boundary rule is used for stems above.
    const numberMatch = block.kind === "p" ? paragraph.match(/^\s*(\d{1,3})(?:[．、]|\.(?!\d))\s*([\s\S]*)$/) : null;
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
  const embeddedAssets = (xml: string[]) => Object.fromEntries(Array.from(new Set(xml.flatMap((item) => Array.from(item.matchAll(/r:embed="([^"]+)"/g), (match) => match[1])))).flatMap((id) => imageAssets[id] ? [[id, imageAssets[id]]] : []));
  for (const question of questions) {
    question.stemDocxAssets = embeddedAssets(question.stemDocxXml);
    question.optionsDocxAssets = embeddedAssets(question.optionsDocxXml);
    question.contentImages = Array.from(new Set(Object.values(embeddedAssets([...question.stemDocxXml, ...question.optionsDocxXml]))));
    if (question.analysisDocxXml) question.analysisDocxAssets = embeddedAssets(question.analysisDocxXml);
  }
  const questionImages = Object.fromEntries(questions.map((question) => [question.questionNumber, question.contentImages]));
  const analyses = Object.fromEntries(Object.entries(analysisParts).map(([number, parts]) => [number, parts.join("\n")]));
  for (const question of questions) {
    if (!answers[question.questionNumber] && question.type === "填空题") {
      const inferred = inferFilledAnswer(question.firstParagraph, repeatedQuestionText[question.questionNumber] ?? "");
      if (inferred) answers[question.questionNumber] = inferred;
    }
    if (!answers[question.questionNumber] && question.type === "解答题" && analyses[question.questionNumber]) answers[question.questionNumber] = "见解析";
  }
  return { paragraphs, answerSectionStart, pageCount, answers, analyses, analysisXml, analysisAssets, questionImages, options, questions: questions.map((question): StructuredDocxQuestion => ({ questionNumber: question.questionNumber, type: question.type, stem: question.stem, stemParagraphs: question.stemParagraphs, stemDocxXml: question.stemDocxXml, stemDocxAssets: question.stemDocxAssets, options: question.options, optionsDocxXml: question.optionsDocxXml, optionsDocxAssets: question.optionsDocxAssets, sourcePage: question.sourcePage, contentImages: question.contentImages, warnings: question.warnings, answer: question.answer, analysis: question.analysis, analysisDocxXml: question.analysisDocxXml, analysisDocxAssets: question.analysisDocxAssets })) };
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

// The browser draws a rendered Word page itself through an SVG foreignObject: text, Word equations (MathML) and
// pictures exactly as it shows them, with the page's own style sheets. html2canvas, the fallback, cannot paint
// equations and sets Chinese text lower than the browser does. Throws when the browser will not draw it.
async function drawPage(page: HTMLElement, scale: number) {
  const box = page.getBoundingClientRect(), inherited = getComputedStyle(page.parentElement ?? page);
  const styles = Array.from(document.styleSheets).flatMap((sheet) => { try { return Array.from(sheet.cssRules, (rule) => rule.cssText); } catch { return []; } }).join("\n");
  const width = Math.ceil(box.width * scale), height = Math.ceil(box.height * scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" class="docx-wrapper" style="padding:0;margin:0;background:#fff;display:block;width:${box.width}px;transform:scale(${scale});transform-origin:0 0;font-family:${inherited.fontFamily.replace(/"/g, "'")};font-size:${inherited.fontSize};line-height:${inherited.lineHeight};color:${inherited.color}"><style>${styles.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</style>${new XMLSerializer().serializeToString(page)}</div></foreignObject></svg>`;
  const picture = new Image(); picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; await picture.decode();
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false }); if (!context) throw new Error("无法绘制 Word 页面");
  context.fillStyle = "#fff"; context.fillRect(0, 0, width, height); context.drawImage(picture, 0, 0);
  context.getImageData(0, 0, 1, 1); // a browser that taints such drawings refuses here, before any slicing
  return canvas;
}

// A paragraph's text for the AI, with each equation given as its $LaTeX$ rather than its glyphs.
function hintText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  const latex = node instanceof Element ? node.getAttribute("data-latex") : null;
  if (latex !== null) return `$${latex}$`;
  return Array.from(node.childNodes).map(hintText).join("");
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
  // docx-preview does not show VML pictures, so they become inline DrawingML first. Pages are drawn by the browser
  // (drawPage), equations included, each keeping its LaTeX for the AI; whatever is still missing is reported.
  const archive = await JSZip.loadAsync(buffer);
  const pictures = docxVmlPicturesToDrawing(await archive.file("word/document.xml")?.async("text") ?? "", 10000);
  archive.file("word/document.xml", pictures.xml);
  const body = pictures.xml.match(/<w:body\b[\s\S]*<\/w:body>/)?.[0] ?? "";
  const formulas = docxMathLatex(body); const expectedPictures = (body.match(/<a:blip\b[^>]*\br:embed="/g) ?? []).length;
  const renderNotes: string[] = [];
  const host = document.createElement("div"); host.className = "file-import-render-host";
  Object.assign(host.style, { position: "fixed", left: "-12000px", top: "0", width: "900px", background: "white", zIndex: "-1" });
  document.body.appendChild(host);
  try {
    await renderAsync(await archive.generateAsync({ type: "arraybuffer" }), host, undefined, { className: "docx", inWrapper: true, breakPages: true, ignoreWidth: false, ignoreHeight: false, renderHeaders: true, renderFooters: true, useBase64URL: true });
    await waitForImages(host); await document.fonts.ready;
    // LaTeX goes with an equation only when the page shows exactly the document's equations, in order.
    const equations = Array.from(host.querySelectorAll("article math"));
    if (equations.length === formulas.length) equations.forEach((equation, index) => equation.setAttribute("data-latex", formulas[index]));
    else if (formulas.length) renderNotes.push(`Word 中有 ${formulas.length} 个公式，页面转换只找到 ${equations.length} 个，识别结果可能缺少公式，请对照原件核对`);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const drawn = Array.from(host.querySelectorAll<HTMLImageElement>("article img")).filter((image) => image.naturalWidth > 0).length;
    if (drawn < expectedPictures) renderNotes.push(`Word 中有 ${expectedPictures} 张图片，页面转换只画出 ${drawn} 张，识别结果可能缺少配图，请对照原件核对`);
    const renderedPages = Array.from(host.querySelectorAll<HTMLElement>("section.docx"));
    const targets = renderedPages.length ? renderedPages : [host];
    const renderedCanvases: Array<{ canvas: HTMLCanvasElement; target: HTMLElement }> = [];
    try { for (const target of targets) renderedCanvases.push({ canvas: await drawPage(target, 1.7), target }); }
    catch {
      renderedCanvases.length = 0;
      for (const target of targets) renderedCanvases.push({ canvas: await html2canvas(target, { backgroundColor: "#ffffff", scale: 1.7, logging: false, useCORS: true }), target });
      if (equations.length) renderNotes.push(`这个浏览器不能把 Word 公式画进页面图片，${equations.length} 个公式只以文字提示交给 AI，识别结果可能缺少公式；建议改用 Chrome 或 Edge 导入`);
    }
    let answerSectionSeen = false;
    const pageSlices = renderedCanvases.flatMap(({ canvas, target }) => {
      const a4Height = Math.round(canvas.width * 297 / 210);
      const sliceCount = Math.ceil(canvas.height / a4Height); const hints = Array.from({ length: sliceCount }, () => [] as string[]); const answerFlags = Array.from({ length: sliceCount }, () => false);
      const targetRect = target.getBoundingClientRect(); const scale = canvas.width / Math.max(1, targetRect.width);
      const paragraphs = Array.from(target.querySelectorAll<HTMLElement>("article p"));
      for (const paragraph of paragraphs) {
        const hint = hintText(paragraph).trim();
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
      pages.push({ pageNumber: index + 1, image: canvasDataUrl(pageSlices[index].canvas), textHint: pageSlices[index].textHint, documentSection: pageSlices[index].documentSection, ...(index === 0 && renderNotes.length ? { renderNotes } : {}), sourceAnswers: sourceDocument.answers, sourceAnalyses: sourceDocument.analyses, sourceAnalysisXml: sourceDocument.analysisXml, sourceAnalysisAssets: sourceDocument.analysisAssets, sourceQuestionImages: sourceDocument.questionImages, sourceOptions: sourceDocument.options, sourceQuestions: sourceDocument.questions }); onProgress(index + 1, pageSlices.length);
    }
    return pages;
  } finally { host.remove(); }
}

// A question read from the Word document's own structure: stem, options, figures, and the answer and analysis
// the document's answer section gives for its number. 录入 and 排版 both build on this.
// An answer section is matched by number only when one question has that number.
export function structuredDocxQuestions(pages: ImportPage[]) {
  const page = pages.find((item) => item.sourceQuestions?.length);
  const questions = page?.sourceQuestions ?? [];
  const unique = (number: string) => questions.filter((item) => item.questionNumber === number).length === 1;
  return questions.map((item) => {
    const byNumber = unique(item.questionNumber);
    return {
      questionNumber: item.questionNumber, type: item.type, sourcePage: item.sourcePage, warnings: item.warnings,
      stem: item.stem, stemParagraphs: item.stemParagraphs, stemDocxXml: item.stemDocxXml, stemDocxAssets: item.stemDocxAssets,
      options: item.options, optionsDocxXml: item.optionsDocxXml, optionsDocxAssets: item.optionsDocxAssets,
      answer: item.answer ?? (byNumber ? page?.sourceAnswers?.[item.questionNumber] : undefined) ?? (item.type === "解答题" ? "见解析" : ""),
      analysis: item.analysis ?? (byNumber ? page?.sourceAnalyses?.[item.questionNumber] : undefined) ?? "",
      analysisDocxXml: item.analysisDocxXml ?? (byNumber ? page?.sourceAnalysisXml?.[item.questionNumber] : undefined),
      analysisDocxAssets: item.analysisDocxAssets ?? (byNumber ? page?.sourceAnalysisAssets?.[item.questionNumber] : undefined),
      contentImages: item.contentImages,
    };
  });
}

export async function renderImportFile(file: File, onProgress: (current: number, total: number) => void): Promise<ImportPage[]> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (["png", "jpg", "jpeg", "webp"].includes(extension ?? "") || ["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    const image = await readScreenshot(file);
    onProgress(1, 1);
    return [{ pageNumber: 1, image }];
  }
  if (extension === "pdf" || file.type === "application/pdf") return renderPdf(file, onProgress);
  if (extension === "docx" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return renderDocx(file, onProgress);
  if (extension === "doc") throw new Error("暂不支持旧版 .doc，请在 Word 中另存为 .docx 后导入");
  throw new Error("请选择 PDF、.docx 或 PNG / JPEG / WebP 图片");
}
