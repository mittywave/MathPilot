"use client";

import { lazy, PointerEvent as ReactPointerEvent, Suspense, useRef, useState } from "react";
import { MathText } from "./MathText";
import { DocxOptions } from "./DocxContent";

// Question text is edited as it reads, with the 知识点 editor in plain-text mode: formulas show rendered,
// never as $…$ source, and the text is saved exactly as before.
const NoteEditor = lazy(() => import("./NoteEditor"));
function TextField({ value, label, placeholder = "", singleLine = false, onChange }: { value: string; label: string; placeholder?: string; singleLine?: boolean; onChange: (value: string) => void }) {
  return <Suspense fallback={<div className="note-editor"><div className="note-editor-body note-preview"><MathText text={value} /></div></div>}>
    <NoteEditor plainText singleLine={singleLine} value={value} label={label} placeholder={placeholder} onChange={onChange} />
  </Suspense>;
}
import { renderImportFile, structuredDocxQuestions, type ImportPage } from "../../lib/file-import";
import { jobPageImage, jobsApi, postJson, RecognitionJobTable, uploadJobPage, useRecognitionJobs } from "./RecognitionJobs";
import { readStudioFilesInBatches } from "../../lib/answer-studio-images";
import { contentFingerprint } from "../../lib/content-fingerprint.mjs";
import type { LibraryImportDraft, LibraryImportSource, StudioJob } from "../../lib/server/answer-studio-jobs";
import { crossPageRepeat, numberedImportTarget, orderedImportTimestamp } from "../../lib/question-order-rules.mjs";
import { saveQuestionImportBatch } from "../../lib/question-import-save.mjs";
import { clipboardImage, compressDataUrl, cropExactDataUrl, fileToDataUrl, imageAspectRatio, materializeImageDataUrl, type NormalizedBox } from "../../lib/image-tools";
import { droppedImage, readScreenshot, recognizeScreenshot } from "../../lib/screenshot-recognition";
import { isPhotographedDiagram } from "../../lib/image-processing-rules.mjs";
import { extractRecognizedDiagram, shouldReconstructRecognizedDiagram } from "../../lib/recognition-diagram";
import type { BatchRecognitionResult, RecognitionQuestionResult } from "../../lib/recognition-contract";
import { renderVectorDiagramPlan, VectorDiagramFitError } from "../../lib/vector-diagram-renderer";
import { isGeometryQuestion, questionImages, resolveQuestionImageLayout } from "../../lib/question-layout";
import { cleanRecognizedAnalysis, cleanRecognizedAnswer } from "../../lib/recognition-cleanup.mjs";
import { createCloudQuestion, updateCloudQuestion } from "../../lib/api-client";
import { alevelTagVersions, isAlevel9709ModuleName } from "../../lib/alevel-page-locale.mjs";
import { categoryPath } from "../../lib/library-tree";
import { randomClientId } from "../../lib/client-random-id.mjs";
import type { Category, DiagramQuality, Difficulty, ImageLayout, LibraryModule, Question, QuestionType, VectorDiagramPlan } from "../../lib/types";

// 新建试题 and 讲义编撰 share this dialog, so every entry path saves the same question format.

const questionTypes: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];
const difficulties: Difficulty[] = ["基础", "中等", "提高"];
const emptyDraft = (): Question => ({ id: "", categoryId: "", type: "单选题", difficulty: "基础", examYear: "", stem: "", options: ["", "", "", ""], answer: "", analysis: "", source: "", createdAt: 0, updatedAt: 0 });

type OptimizationResult = {
  stem: string; options: string[]; answer: string; analysis: string; source: string; tags: string[];
  image_layout: ImageLayout; changes: string[];
};
type FileImportDraft = Question & { importId: string; selected: boolean; documentNumber: string };
type FileImportStep = "choose" | "rendering" | "recognizing" | "review";
// A page the background import job read, or failed to read, with what the review needs from it.
type RecognizedImportPage = { page: { pageNumber: number; image: string; textHint?: string; documentSection?: "questions" | "answers" } } & ({ result: BatchRecognitionResult } | { error: string });

function uid(prefix: string) { return `${prefix}-${randomClientId()}`; }
function currentTimestamp() { return Date.now(); }
function monotonicTime() { return performance.now(); }
function parseTagInput(value: string) { return value.split(/[，,]/).map((item) => item.trim()).filter(Boolean); }
function explicitChoiceFromAnalysis(value: string) {
  return value.match(/(?:故选|答案(?:为)?)[：:]?\s*([A-F])(?=[。．，、\s]|$)/i)?.[1].toUpperCase() ?? "";
}

function importedDocxTableCount(question: Question) {
  return [...(question.stemDocxXml ?? []), ...(question.optionsDocxXml ?? [])].filter((xml) => /<w:tbl\b/.test(xml)).length;
}

function isUsableImportedAnswer(value: string) {
  const answer = cleanRecognizedAnswer(value);
  return Boolean(answer) && !/(?:待|后续|补全|不完整|未知|未识别|无法确定|请校对)/.test(answer);
}

function explicitChoicesFromSourceText(value: string) {
  const answers = new Map<string, string>();
  let currentNumber = "";
  for (const line of value.split(/\n+/)) {
    const number = line.match(/^\s*(\d{1,3})[.．、]/)?.[1];
    if (number) currentNumber = number;
    const choice = explicitChoiceFromAnalysis(line);
    if (currentNumber && choice) answers.set(currentNumber, choice);
  }
  return answers;
}

function normalizeAnswerFields(rawAnswer: string, rawAnalysis: string) {
  let answer = cleanRecognizedAnswer(rawAnswer); let analysis = cleanRecognizedAnalysis(rawAnalysis);
  const combined = answer.match(/^([^。\n]{1,24})。\s*([\s\S]+)$/);
  if (combined && !analysis) { answer = combined[1].trim(); analysis = combined[2].trim(); }
  if (!isUsableImportedAnswer(answer)) answer = explicitChoiceFromAnalysis(analysis);
  return { answer, analysis };
}

// What a Word file gives by question number, kept with its import job for the review.
function wordSource(page: ImportPage | undefined): LibraryImportSource | undefined {
  if (!page) return undefined;
  const source: LibraryImportSource = { answers: page.sourceAnswers, analyses: page.sourceAnalyses, analysisXml: page.sourceAnalysisXml, analysisAssets: page.sourceAnalysisAssets, questionImages: page.sourceQuestionImages, options: page.sourceOptions };
  const present = Object.entries(source).filter(([, value]) => value && Object.keys(value).length);
  return present.length ? Object.fromEntries(present) as LibraryImportSource : undefined;
}

export function newQuestionDraft(module: LibraryModule, categoryId: string): Question {
  return { ...emptyDraft(), moduleId: module.id, categoryId, imageLayout: "right", contentImages: [], ...(isAlevel9709ModuleName(module.name) ? { tags: [], tagsZh: [], tagsEn: [] } : {}) };
}

export function editableQuestionDraft(question: Question, module?: LibraryModule): Question {
  const tagVersions = alevelTagVersions(question);
  return { ...question, options: [...question.options], contentImages: [...(question.contentImages ?? [])], ...(isAlevel9709ModuleName(module?.name) ? { tags: tagVersions.zh, tagsZh: tagVersions.zh, tagsEn: tagVersions.en } : {}) };
}

type QuestionEntryProps = {
  initial: Question;
  modules: LibraryModule[];
  categories: Category[];
  // Modules whose categories may receive the question; the module follows the chosen category.
  moduleIds: string[];
  onSaved: (questions: Question[]) => void;
  onClose: () => void;
  onNotice: (message: string, tone?: "success" | "error") => void;
  // Handouts and the basket keep their own snapshots after new questions join the library.
  saveTemporaryQuestions?: (questions: Question[]) => Promise<Question[]>;
  startWithFile?: boolean;
  // A wrong-book question joining the library: saved as a new library question that keeps its ID.
  addToLibrary?: boolean;
};

export function QuestionEntry({ initial, modules, categories, moduleIds, onSaved, onClose, onNotice: setNotice, saveTemporaryQuestions, startWithFile = false, addToLibrary = false }: QuestionEntryProps) {
  const [questionDraft, setQuestionDraft] = useState<Question | null>(initial);
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [isReconstructingDiagram, setIsReconstructingDiagram] = useState(false);
  const [recognitionError, setRecognitionError] = useState("");
  // New questions come from a screenshot (or a file import). Editing a question that was not entered from a
  // screenshot keeps the plain form with its figure list.
  const screenshotEntry = !initial.id || Boolean(initial.originalImage);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizationError, setOptimizationError] = useState("");
  const [optimizationPreview, setOptimizationPreview] = useState<OptimizationResult | null>(null);
  const [cropDialog, setCropDialog] = useState(false);
  const [cropSelection, setCropSelection] = useState<NormalizedBox | null>(null);
  const [cropStart, setCropStart] = useState<{ x: number; y: number } | null>(null);
  const [fileImportOpen, setFileImportOpen] = useState(startWithFile);
  const [fileImportStep, setFileImportStep] = useState<FileImportStep>("choose");
  const [fileImportName, setFileImportName] = useState("");
  const [fileImportCategory, setFileImportCategory] = useState(initial.categoryId);
  const [fileImportProgress, setFileImportProgress] = useState({ current: 0, total: 0, label: "" });
  const [fileImportDrafts, setFileImportDrafts] = useState<FileImportDraft[]>([]);
  const [fileImportErrors, setFileImportErrors] = useState<string[]>([]);
  const [fileImportNotice, setFileImportNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [openImportJobId, setOpenImportJobId] = useState("");
  const [isSavingImportedQuestions, setIsSavingImportedQuestions] = useState(false);
  const fileImportSavingRef = useRef(false);
  const questionImageRef = useRef<HTMLInputElement>(null);
  const manualImagesRef = useRef<HTMLInputElement>(null);
  const fileImportRef = useRef<HTMLInputElement>(null);
  const cropStageRef = useRef<HTMLDivElement>(null);
  const fileImportAbortRef = useRef<AbortController | null>(null);
  // PDF, pictures and Word files without a readable structure are read by the AI in background jobs, listed here.
  const imports = useRecognitionJobs("import", fileImportOpen, (message) => setFileImportNotice(message ? { text: message, error: true } : null), (job) => { if (openImportJobId === job.id) setOpenImportJobId(""); });

  const moduleById = (id: string | null | undefined) => modules.find((item) => item.id === id);
  const entryModules = moduleIds.flatMap((id) => moduleById(id) ?? []);
  const entryCategories = categories.filter((item) => moduleIds.includes(item.moduleId ?? ""));
  const pathOf = (id: string) => categoryPath(modules, categories, id);
  const moduleOf = (categoryId: string) => moduleById(categoryId) ?? moduleById(categories.find((item) => item.id === categoryId)?.moduleId);
  const isAlevelCategory = (categoryId: string) => isAlevel9709ModuleName(moduleOf(categoryId)?.name);
  const recognitionCategories = entryCategories.map((item) => ({ id: item.id, path: pathOf(item.id) }));
  const categoryOptions = entryModules.flatMap((module) => [
    <option key={module.id} value={module.id}>{module.name}（模块根目录）</option>,
    ...entryCategories.filter((item) => item.moduleId === module.id).map((item) => <option key={item.id} value={item.id}>{pathOf(item.id)}</option>),
  ]);
  const questionDraftModule = questionDraft ? moduleOf(questionDraft.categoryId) ?? moduleById(questionDraft.moduleId) : undefined;
  const manualImages = questionDraft?.contentImages?.filter((image) => questionImages(questionDraft).includes(image)) ?? [];
  const questionDraftIsAlevel = isAlevel9709ModuleName(questionDraftModule?.name);
  const isAlevelImport = isAlevelCategory(fileImportCategory);


  function openFileImport() {
    if (!entryModules.length && !saveTemporaryQuestions) return;
    // Imported questions go to the module (or category) the entry was opened from.
    setFileImportCategory(initial.categoryId || entryModules[0]?.id || "");
    setFileImportOpen(true); setFileImportStep("choose"); setFileImportName(""); setFileImportDrafts([]); setFileImportErrors([]);
    setFileImportProgress({ current: 0, total: 0, label: "" });
  }

  // Back to the screenshot entry with its draft as it was; a file still being read is abandoned.
  function backToScreenshotEntry() { if (fileImportSavingRef.current) return; fileImportAbortRef.current?.abort(); fileImportAbortRef.current = null; setFileImportOpen(false); }

  function closeFileImport() { if (fileImportSavingRef.current) return; fileImportAbortRef.current?.abort(); fileImportAbortRef.current = null; setFileImportOpen(false); onClose(); }

  async function handleImportDocument(file: File) {
    if (file.size > 80 * 1024 * 1024) { setFileImportErrors(["文件超过 80MB，请拆分后再导入"]); return; }
    const docx = /\.docx$/i.test(file.name) || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (/\.doc$/i.test(file.name)) { setFileImportErrors(["暂不支持旧版 .doc，请在 Word 中另存为 .docx 后导入"]); return; }
    if (!docx && !/\.pdf$/i.test(file.name) && !/^image\/(png|jpeg|webp)$/.test(file.type)) { setFileImportErrors(["请选择 PDF、.docx 或 PNG / JPEG / WebP 图片"]); return; }
    const controller = new AbortController(); fileImportAbortRef.current = controller; setFileImportName(file.name); setFileImportDrafts([]); setFileImportErrors([]); setFileImportNotice(null); setOpenImportJobId(""); setFileImportStep("rendering");
    let unfinished = "";
    try {
      // A Word file whose structure can be read goes straight to the review; nothing is sent to the AI.
      const pages = docx ? await renderImportFile(file, (current, total) => setFileImportProgress({ current, total, label: `正在读取第 ${current}/${total} 页` })) : [];
      if (controller.signal.aborted) return;
      const structuredQuestions = structuredDocxQuestions(pages);
      if (structuredQuestions.length) {
        setFileImportStep("recognizing"); setFileImportProgress({ current: structuredQuestions.length, total: structuredQuestions.length, label: `已按 Word 原始结构整理 ${structuredQuestions.length} 道题` });
        const timestamp = currentTimestamp();
        // A 文件转录 answers-only export has headings and solutions but no stems; such a question cannot be saved.
        const imported = structuredQuestions.map<FileImportDraft>(({ questionNumber, warnings, ...item }, index) => ({
          ...item, id: uid("q"), importId: uid("import"), selected: Boolean(item.stem.trim()), documentNumber: questionNumber,
          categoryId: fileImportCategory, difficulty: item.type === "解答题" ? "提高" : "中等",
          examYear: "", source: "", tags: [], ...(isAlevelImport ? { tagsZh: [], tagsEn: [] } : {}), recognitionConfidence: 1,
          recognitionWarnings: ["题干、配图和解析均从 Word 原始结构读取", ...warnings, ...(item.stem.trim() ? [] : ["原件这道题只有解析，没有题干，不能保存为题目"])], importFileName: file.name,
          createdAt: orderedImportTimestamp(timestamp, index), updatedAt: orderedImportTimestamp(timestamp, index),
        }));
        setFileImportDrafts(imported); setFileImportStep("review"); return;
      }
      // Everything else is read page by page by the AI in a background job: pages are uploaded in order, then the
      // teacher may close this window and open the job's result here later.
      const { job } = await jobsApi<{ job: StudioJob }>("/api/answer-studio/jobs", postJson({ kind: "import", title: file.name, categories: recognitionCategories, notes: pages[0]?.renderNotes ?? [], source: wordSource(pages[0]) }));
      unfinished = job.id; imports.setJobs((current) => [job, ...current]);
      let uploaded = 0;
      const upload = async (page: { id: string; page: number; name: string; hash: string; image: string; textHint?: string; documentSection?: "questions" | "answers" }) => {
        if (controller.signal.aborted) throw new DOMException("文件录入已取消", "AbortError");
        setFileImportProgress({ current: uploaded, total: pages.length || uploaded + 1, label: `正在上传第 ${uploaded + 1} 页，上传完成前请勿关闭窗口` });
        await uploadJobPage(job.id, page); uploaded += 1;
      };
      // Answer pages whose analyses the Word file already gives need no AI.
      if (docx) for (const page of pages) { if (!(page.documentSection === "answers" && page.sourceAnalyses)) await upload({ id: randomClientId(), page: page.pageNumber, name: file.name, hash: await contentFingerprint(page.image), image: page.image, textHint: page.textHint, documentSection: page.documentSection }); }
      else await readStudioFilesInBatches([file], "question", "", (label) => setFileImportProgress((current) => ({ ...current, label })), async (batch) => { for (const page of batch) await upload({ id: page.id, page: page.page, name: page.name, hash: page.hash, image: page.image }); });
      if (!uploaded) throw new Error("文件里没有需要识别的页面");
      await jobsApi(`/api/answer-studio/jobs/${job.id}`, { method: "POST" });
      unfinished = "";
      setFileImportNotice({ text: `「${file.name}」已转入后台识别（${uploaded} 页），可以关闭窗口；识别完成后在下面的识别任务里打开校对。`, error: false });
      setFileImportStep("choose"); void imports.refresh();
    } catch (error) {
      // Without the file a half-uploaded job can never start, so it does not stay in the list.
      if (unfinished) { await jobsApi(`/api/answer-studio/jobs/${unfinished}`, { method: "DELETE" }).catch(() => undefined); imports.setJobs((current) => current.filter((item) => item.id !== unfinished)); }
      if (!controller.signal.aborted) { setFileImportErrors([error instanceof Error ? error.message : "无法读取这个文件"]); setFileImportStep("choose"); }
    }
    finally { if (fileImportAbortRef.current === controller) fileImportAbortRef.current = null; }
  }

  // A finished (or partly finished) import job: what the AI read on each page, with the page pictures for figures.
  async function openImportJob(job: StudioJob) {
    setFileImportName(job.title); setFileImportDrafts([]); setFileImportErrors([]); setFileImportNotice(null); setFileImportStep("rendering");
    setFileImportProgress({ current: 0, total: job.pageCount, label: "正在读取识别结果…" });
    try {
      const { draft } = await jobsApi<{ draft: LibraryImportDraft }>(`/api/answer-studio/jobs/${job.id}`);
      const recognizedPages: RecognizedImportPage[] = [];
      for (const [index, page] of draft.pages.entries()) {
        setFileImportProgress({ current: index, total: draft.pages.length, label: `正在读取第 ${index + 1}/${draft.pages.length} 页原件` });
        const outcome = draft.results[page.id], at = { pageNumber: page.page, textHint: page.textHint, documentSection: page.documentSection };
        recognizedPages.push(outcome?.result ? { page: { ...at, image: await jobPageImage(job.id, page.id, `第 ${page.page} 页`) }, result: outcome.result } : { page: { ...at, image: "" }, error: outcome?.error ?? "这一页还没有识别" });
      }
      setOpenImportJobId(job.id);
      await reviewRecognizedPages(draft.fileName, recognizedPages, draft.notes, draft.source);
    } catch (error) { setFileImportNotice({ text: error instanceof Error ? error.message : "打开失败", error: true }); setFileImportStep("choose"); }
  }

  // Questions from the pages, figures cut from them, answers given by number filled in, then the review.
  async function reviewRecognizedPages(fileName: string, recognizedPages: RecognizedImportPage[], notes: string[], source: LibraryImportSource | undefined) {
    const imported: FileImportDraft[] = []; const pageErrors: string[] = [...notes]; const seen = new Set<string>(); const importStartedAt = currentTimestamp();
    // Sections may restart their numbering, so the same number is kept; only a page-break repeat is left unselected.
    let previous: { pageNumber: number; type: string; number: string } | undefined;
    for (const recognized of recognizedPages.sort((a, b) => a.page.pageNumber - b.page.pageNumber)) {
      if ("error" in recognized) { pageErrors.push(`第 ${recognized.page.pageNumber} 页：${recognized.error}`); continue; }
      if (recognized.page.documentSection === "answers") continue;
      for (const [index, item] of (recognized.result.questions ?? []).entries()) {
        const position = { pageNumber: recognized.page.pageNumber, type: item.type, number: item.question_number.trim() };
        const repeat = crossPageRepeat(previous, position, index === 0); previous = position;
        const stemKey = item.stem.replace(/\s+/g, "").replace(/[，。；：,.!?！？]/g, "").slice(0, 100);
        if (!stemKey || seen.has(stemKey)) continue; seen.add(stemKey);
        const extracted = await extractRecognizedDiagram(recognized.page.image, item); item.warnings = extracted.warnings;
        let reconstruction: Partial<Question> = extracted.fields;
        if (shouldReconstructRecognizedDiagram(extracted.diagramImage, item.diagram_quality)) {
          setFileImportProgress((current) => ({ ...current, label: `正在为第 ${item.question_number || imported.length + 1} 题高清重绘配图` }));
          try {
            const rebuilt = await requestVectorDiagramReconstruction(item.stem, extracted.diagramImage!, item.diagram_quality);
            if (rebuilt.skipped) item.warnings = [...item.warnings, rebuilt.reason];
            else reconstruction = { ...reconstruction, diagramOriginalImage: reconstruction.diagramImage, diagramImage: rebuilt.image, diagramSource: "svg-ai", diagramQuality: item.diagram_quality ?? undefined, vectorDiagramSvg: rebuilt.svg, vectorDiagramPlan: rebuilt.plan, diagramReconstructionConfidence: rebuilt.plan.confidence, diagramVisualFitScore: rebuilt.visualFitScore, diagramReconstructionWarnings: rebuilt.plan.warnings, diagramReconstructedAt: currentTimestamp() };
          } catch (error) { item.warnings = [...item.warnings, `高清矢量重绘未完成：${error instanceof Error ? error.message : "未知错误"}`]; }
        }
        const timestamp = orderedImportTimestamp(importStartedAt, imported.length); const categoryId = item.suggested_category_id && entryCategories.some((entry) => entry.id === item.suggested_category_id) ? item.suggested_category_id : fileImportCategory;
        const normalized = normalizeAnswerFields(item.answer, item.analysis);
        const tagVersions = alevelTagVersions({ tags: item.tags });
        if (repeat) item.warnings = [...item.warnings, `与上一页最后一题同为第 ${position.number} 题，可能是跨页重复识别，已默认不选；如是另一道题请勾选`];
        imported.push({ id: uid("q"), importId: uid("import"), selected: !repeat, documentNumber: item.question_number, categoryId, type: item.type, difficulty: item.difficulty, examYear: "", stem: item.stem, options: item.options, answer: normalized.answer, analysis: normalized.analysis, source: item.source, tags: isAlevelImport ? tagVersions.zh : item.tags, ...(isAlevelImport ? { tagsZh: tagVersions.zh, tagsEn: tagVersions.en } : {}), diagramBox: item.diagram_bbox ?? undefined, recognitionConfidence: item.confidence, recognitionWarnings: item.warnings, importFileName: fileName, sourcePage: recognized.page.pageNumber, createdAt: timestamp, updatedAt: timestamp, ...reconstruction });
      }
    }
    // The source gives answers and some content by number; fill in only a number that names one question.
    const numbered = (questionNumber: string) => {
      const { target, clash } = numberedImportTarget(imported, questionNumber);
      const warning = `有多道第 ${questionNumber} 题，原件按题号给出的答案、解析等未自动填入，请对照原件核对`;
      for (const entry of clash) if (!entry.recognitionWarnings?.includes(warning)) entry.recognitionWarnings = [...(entry.recognitionWarnings ?? []), warning];
      return target;
    };
    for (const recognized of recognizedPages) {
      if ("error" in recognized) continue;
      for (const answerItem of recognized.result.answers ?? []) {
        const target = numbered(answerItem.question_number);
        if (!target) continue;
        const normalized = normalizeAnswerFields(answerItem.answer, answerItem.analysis);
        if (isUsableImportedAnswer(normalized.answer)) target.answer = normalized.answer;
        if (normalized.analysis.length > target.analysis.length) target.analysis = normalized.analysis;
        if (!isUsableImportedAnswer(target.answer)) target.answer = explicitChoiceFromAnalysis(target.analysis);
      }
    }
    for (const recognized of recognizedPages) {
      if ("error" in recognized || !recognized.page.textHint) continue;
      for (const [questionNumber, answer] of explicitChoicesFromSourceText(recognized.page.textHint)) {
        const target = numbered(questionNumber);
        if (target) target.answer = answer;
      }
    }
    const sourceAnswers = source?.answers;
    for (const [questionNumber, answer] of Object.entries(sourceAnswers ?? {})) {
      const target = numbered(questionNumber);
      if (target) target.answer = answer;
    }
    const sourceAnalyses = source?.analyses;
    for (const [questionNumber, analysis] of Object.entries(sourceAnalyses ?? {})) {
      const target = numbered(questionNumber);
      if (target && analysis.trim()) target.analysis = analysis.trim();
    }
    const sourceAnalysisXml = source?.analysisXml;
    for (const [questionNumber, analysisDocxXml] of Object.entries(sourceAnalysisXml ?? {})) {
      const target = numbered(questionNumber);
      if (target && analysisDocxXml.length) target.analysisDocxXml = analysisDocxXml;
    }
    const sourceAnalysisAssets = source?.analysisAssets;
    for (const [questionNumber, analysisDocxAssets] of Object.entries(sourceAnalysisAssets ?? {})) {
      const target = numbered(questionNumber);
      if (target && Object.keys(analysisDocxAssets).length) target.analysisDocxAssets = analysisDocxAssets;
    }
    const sourceQuestionImages = source?.questionImages;
    for (const [questionNumber, contentImages] of Object.entries(sourceQuestionImages ?? {})) {
      const target = numbered(questionNumber);
      if (target && contentImages.length) { target.contentImages = contentImages; target.diagramImage = undefined; target.diagramBox = undefined; }
    }
    const sourceOptions = source?.options;
    for (const [questionNumber, options] of Object.entries(sourceOptions ?? {})) {
      const target = numbered(questionNumber);
      if (target && options.length >= 2) target.options = options;
    }
    for (const target of imported) {
      if (!isUsableImportedAnswer(target.answer)) target.answer = explicitChoiceFromAnalysis(target.analysis);
    }
    setFileImportDrafts(imported); setFileImportErrors(pageErrors); setFileImportStep("review");
  }

  function updateImportDraft(importId: string, changes: Partial<FileImportDraft>) {
    setFileImportDrafts((current) => current.map((item) => item.importId === importId ? {
      ...item,
      ...changes,
      ...(changes.stem === undefined ? {} : { stemParagraphs: undefined, stemDocxXml: undefined, stemDocxAssets: undefined }),
      ...(changes.options === undefined ? {} : { optionsDocxXml: undefined, optionsDocxAssets: undefined }),
      ...(changes.analysis === undefined ? {} : { analysisDocxXml: undefined, analysisDocxAssets: undefined }),
    } : item));
  }

  async function saveImportedQuestions() {
    if (fileImportSavingRef.current) return;
    const selected = fileImportDrafts.filter((item) => item.selected && item.stem.trim() && item.categoryId);
    if (!selected.length) { setNotice("请至少选择一道题，并确认题干和分类", "error"); return; }
    const incompleteIndex = selected.findIndex((item) => { if (!isAlevelCategory(item.categoryId)) return false; const versions = alevelTagVersions(item); return versions.zh.length !== versions.en.length; });
    if (incompleteIndex >= 0) { setNotice(`第 ${incompleteIndex + 1} 道已选题目的中英文知识点数量不一致，请按顺序配对`, "error"); return; }
    const saved: Question[] = selected.map((item) => {
      const question = { ...item } as Partial<FileImportDraft>;
      delete question.importId; delete question.selected; delete question.documentNumber;
      const tagVersions = alevelTagVersions(item);
      return { ...question, moduleId: moduleOf(item.categoryId)?.id, stem: item.stem.trim(), stemParagraphs: item.stem.split(/\r?\n/).filter((line) => line.length > 0), options: item.options.map((option) => option.trim()).filter(Boolean), ...(isAlevelCategory(item.categoryId) ? { tags: tagVersions.zh, tagsZh: tagVersions.zh, tagsEn: tagVersions.en } : {}), updatedAt: currentTimestamp() } as Question;
    });
    fileImportSavingRef.current = true; setIsSavingImportedQuestions(true); setFileImportErrors([]);
    try {
      const result = await saveQuestionImportBatch(saved, async (question) => (await createCloudQuestion(question)).question);
      const uploaded = result.saved.map((item) => item.question);
      const savedIds = new Set(result.saved.map((item) => item.draft.id));
      if (uploaded.length) {
        if (saveTemporaryQuestions) await saveTemporaryQuestions(uploaded);
        onSaved(uploaded);
      }
      setFileImportDrafts((current) => current.filter((item) => !savedIds.has(item.id)));
      if (result.failed.length) {
        const errors = [...new Set(result.failed.map((item) => item.error))];
        setFileImportErrors([`已保存 ${uploaded.length} 道，剩余 ${result.failed.length} 道保存失败。可再次保存剩余题目。`, ...errors]);
        setNotice(`已保存 ${uploaded.length} 道题，剩余 ${result.failed.length} 道请重试`, "error");
      } else {
        setFileImportOpen(false); setNotice(saveTemporaryQuestions ? `已导入 ${uploaded.length} 道题，已分配 ID 并加入正式题库` : `已从文件录入 ${uploaded.length} 道云端试题`); onClose();
      }
    } catch (error) { setFileImportErrors([error instanceof Error ? error.message : "临时题目保存失败，请重试"]); }
    finally { fileImportSavingRef.current = false; setIsSavingImportedQuestions(false); }
  }

  async function requestVectorDiagramReconstruction(stem: string, image: string, quality: DiagramQuality | undefined | null) {
    const uploadImage = await materializeImageDataUrl(image, 1600);
    const aspectRatio = await imageAspectRatio(uploadImage);
    let previousPlan: VectorDiagramPlan | undefined; let fitFeedback: string[] | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch("/api/reconstruct-diagram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: uploadImage, stem, qualityIssues: quality?.issues ?? [], imageAspectRatio: aspectRatio, previousPlan, fitFeedback }),
      });
      const payload = await response.json() as { result?: VectorDiagramPlan; skipped?: boolean; reason?: string; error?: string; code?: string };
      if (payload.skipped) return { skipped: true as const, reason: payload.reason || "这幅图不适合自动矢量重绘" };
      if (!response.ok || !payload.result) throw new Error(payload.code === "MISSING_API_KEY" ? "高清矢量重绘尚未配置" : payload.error || "没有生成可用的重绘方案");
      try {
        const rendered = await renderVectorDiagramPlan(payload.result, uploadImage, { allowSourceAnnotations: isPhotographedDiagram(quality) });
        return { skipped: false as const, plan: payload.result, ...rendered };
      } catch (error) {
        if (!(error instanceof VectorDiagramFitError) || attempt === 1) throw error;
        previousPlan = payload.result; fitFeedback = error.feedback;
      }
    }
    throw new Error("高清矢量稿未达到原图视觉匹配要求");
  }

  async function recognizeImage(image: string) {
    if (!questionDraft) return;
    setIsRecognizing(true); setRecognitionError("");
    try {
      const recognitionStartedAt = monotonicTime();
      const result = await recognizeScreenshot<RecognitionQuestionResult>("/api/recognize", image, { categories: recognitionCategories });
      const extracted = await extractRecognizedDiagram(image, result);
      let reconstruction: Partial<Question> = extracted.fields;
      const warnings = extracted.warnings;
      const recognitionDurationMs = Math.round(monotonicTime() - recognitionStartedAt);
      const tagVersions = alevelTagVersions({ tags: result.tags });
      const baseDraft: Partial<Question> = { type: result.type, difficulty: result.difficulty, stem: result.stem, options: result.options.length ? result.options : [], answer: cleanRecognizedAnswer(result.answer), analysis: cleanRecognizedAnalysis(result.analysis), source: result.source, tags: questionDraftIsAlevel ? tagVersions.zh : result.tags, ...(questionDraftIsAlevel ? { tagsZh: tagVersions.zh, tagsEn: tagVersions.en } : {}), categoryId: result.suggested_category_id && entryCategories.some((item) => item.id === result.suggested_category_id) ? result.suggested_category_id : questionDraft.categoryId, originalImage: image, contentImages: [], stemDocxXml: undefined, stemDocxAssets: undefined, optionsDocxXml: undefined, optionsDocxAssets: undefined, diagramBox: result.diagram_bbox ?? undefined, recognitionConfidence: result.confidence, recognitionWarnings: warnings, recognitionDurationMs, ...reconstruction };
      setQuestionDraft((current) => current ? { ...current, ...baseDraft } : current);
      setIsRecognizing(false);
      if (shouldReconstructRecognizedDiagram(reconstruction.diagramImage, result.diagram_quality)) {
        setIsReconstructingDiagram(true);
        setNotice(`文字识别已完成（${(recognitionDurationMs / 1000).toFixed(1)} 秒），正在后台高清重绘配图`);
        const reconstructionStartedAt = monotonicTime();
        try {
          const rebuilt = await requestVectorDiagramReconstruction(result.stem, reconstruction.diagramImage!, result.diagram_quality);
          if (rebuilt.skipped) warnings.push(rebuilt.reason);
          else reconstruction = { diagramOriginalImage: reconstruction.diagramImage, diagramImage: rebuilt.image, diagramSource: "svg-ai", vectorDiagramSvg: rebuilt.svg, vectorDiagramPlan: rebuilt.plan, diagramReconstructionConfidence: rebuilt.plan.confidence, diagramVisualFitScore: rebuilt.visualFitScore, diagramReconstructionWarnings: rebuilt.plan.warnings, diagramReconstructedAt: currentTimestamp(), diagramReconstructionDurationMs: Math.round(monotonicTime() - reconstructionStartedAt) };
        } catch (error) { warnings.push(`高清矢量重绘未完成：${error instanceof Error ? error.message : "未知错误"}`); }
        finally { setIsReconstructingDiagram(false); }
        setQuestionDraft((current) => current?.originalImage === image ? { ...current, ...reconstruction, recognitionWarnings: warnings } : current);
      }
      setNotice(reconstruction.diagramSource === "svg-ai" ? "识别完成，低质量配图已完成高清矢量重绘" : "识别完成，请检查后保存");
    } catch (error) { setRecognitionError(error instanceof Error ? error.message : "识别失败，请重试"); }
    finally { setIsRecognizing(false); }
  }

  async function reconstructCurrentDiagram() {
    if (!questionDraft?.stem.trim()) { setRecognitionError("请先确认题干内容"); return; }
    const original = questionDraft.diagramOriginalImage ?? questionDraft.diagramImage;
    if (!original) { setRecognitionError("没有可用于重绘的独立配图"); return; }
    setIsReconstructingDiagram(true); setRecognitionError("");
    try {
      if (questionDraft.vectorDiagramPlan?.strokes?.length) {
        const rendered = await renderVectorDiagramPlan(questionDraft.vectorDiagramPlan, original, { allowSourceAnnotations: isPhotographedDiagram(questionDraft.diagramQuality) });
        setQuestionDraft({ ...questionDraft, diagramOriginalImage: original, diagramImage: rendered.image, diagramSource: "svg-ai", vectorDiagramSvg: rendered.svg, diagramVisualFitScore: rendered.visualFitScore, diagramReconstructedAt: currentTimestamp() });
        setNotice("高清矢量图已重新渲染");
        return;
      }
      const rebuilt = await requestVectorDiagramReconstruction(questionDraft.stem, original, questionDraft.diagramQuality);
      if (rebuilt.skipped) throw new Error(rebuilt.reason);
      setQuestionDraft({ ...questionDraft, diagramOriginalImage: original, diagramImage: rebuilt.image, diagramSource: "svg-ai", vectorDiagramSvg: rebuilt.svg, vectorDiagramPlan: rebuilt.plan, diagramReconstructionConfidence: rebuilt.plan.confidence, diagramVisualFitScore: rebuilt.visualFitScore, diagramReconstructionWarnings: rebuilt.plan.warnings, diagramReconstructedAt: currentTimestamp() });
      setNotice("高清矢量重绘已更新");
    } catch (error) { setRecognitionError(error instanceof Error ? error.message : "高清矢量重绘失败"); }
    finally { setIsReconstructingDiagram(false); }
  }

  async function handleQuestionImage(file: File) {
    let image: string;
    try { image = await readScreenshot(file); } catch (error) { setRecognitionError(error instanceof Error ? error.message : "无法读取这张图片，请换一张重试"); return; }
    setQuestionDraft((current) => current ? { ...current, originalImage: image, contentImages: [], diagramImage: undefined, optionsImage: undefined, diagramOriginalImage: undefined, diagramSource: undefined, diagramQuality: undefined, diagramBox: undefined, geogebraBase64: undefined, geogebraPlan: undefined, vectorDiagramSvg: undefined, vectorDiagramPlan: undefined, diagramReconstructionConfidence: undefined, diagramVisualFitScore: undefined, diagramReconstructionWarnings: undefined, diagramReconstructedAt: undefined } : current);
    await recognizeImage(image);
  }

  async function handleManualImages(files: File[]) {
    const available = Math.max(0, 4 - manualImages.length);
    if (!available) { setNotice("每道题最多添加 4 张配图", "error"); return; }
    const selected = files.filter((file) => file.type.startsWith("image/")).slice(0, available);
    if (!selected.length) { setOptimizationError("请选择 PNG、JPG 或 WebP 图片"); return; }
    if (selected.some((file) => file.size > 15 * 1024 * 1024)) { setOptimizationError("单张图片不能超过 15MB"); return; }
    try {
      const images = await Promise.all(selected.map(async (file) => compressDataUrl(await fileToDataUrl(file))));
      setQuestionDraft((current) => current ? { ...current, contentImages: [...(current.contentImages ?? []), ...images], imageLayout: current.imageLayout ?? "right" } : current);
      setOptimizationError(""); setNotice(`已添加 ${images.length} 张题目配图`);
    } catch { setOptimizationError("无法读取图片，请换一张重试"); }
  }

  async function optimizeDraft() {
    if (!questionDraft?.stem.trim()) { setOptimizationError("请先填写题干，再让 AI 优化"); return; }
    setIsOptimizing(true); setOptimizationError(""); setOptimizationPreview(null);
    try {
      const response = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: questionDraft.type,
          stem: questionDraft.stem,
          options: questionDraft.options.filter(Boolean),
          answer: questionDraft.answer,
          analysis: questionDraft.analysis,
          source: questionDraft.source,
          tags: questionDraft.tags ?? [],
          images: questionImages(questionDraft),
        }),
      });
      const payload = await response.json() as { result?: OptimizationResult; error?: string; code?: string };
      if (!response.ok || !payload.result) throw new Error(payload.code === "MISSING_API_KEY" ? "AI 优化尚未配置，请检查 Sub2API 配置" : payload.error || "优化失败，请重试");
      setOptimizationPreview(payload.result);
    } catch (error) { setOptimizationError(error instanceof Error ? error.message : "优化失败，请重试"); }
    finally { setIsOptimizing(false); }
  }

  function applyOptimization() {
    if (!questionDraft || !optimizationPreview) return;
    const currentTagVersions = alevelTagVersions(questionDraft);
    setQuestionDraft({
      ...questionDraft,
      stem: optimizationPreview.stem,
      stemParagraphs: undefined,
      options: optimizationPreview.options.length ? optimizationPreview.options : questionDraft.options,
      answer: optimizationPreview.answer,
      analysis: optimizationPreview.analysis,
      source: optimizationPreview.source,
      tags: questionDraftIsAlevel ? currentTagVersions.zh : optimizationPreview.tags,
      ...(questionDraftIsAlevel ? { tagsZh: currentTagVersions.zh, tagsEn: currentTagVersions.en } : {}),
      imageLayout: questionImages(questionDraft).length ? optimizationPreview.image_layout : "below",
      optimizedAt: currentTimestamp(),
      stemDocxXml: undefined,
      stemDocxAssets: undefined,
      optionsDocxXml: undefined,
      optionsDocxAssets: undefined,
      analysisDocxXml: undefined,
      analysisDocxAssets: undefined,
    });
    setOptimizationPreview(null); setNotice("已采用 AI 优化结果");
  }

  function cropPoint(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = cropStageRef.current?.getBoundingClientRect(); if (!rect) return { x: 0, y: 0 };
    return { x: Math.max(0, Math.min(1000, (event.clientX - rect.left) / rect.width * 1000)), y: Math.max(0, Math.min(1000, (event.clientY - rect.top) / rect.height * 1000)) };
  }

  function beginManualCrop() {
    if (!questionDraft?.originalImage) return; setCropSelection(questionDraft.diagramBox ?? null); setCropDialog(true);
  }

  async function applyManualCrop() {
    if (!questionDraft?.originalImage || !cropSelection || cropSelection.width < 10 || cropSelection.height < 10) { setNotice("请先框选完整配图", "error"); return; }
    const diagramImage = await cropExactDataUrl(questionDraft.originalImage, cropSelection); setQuestionDraft({ ...questionDraft, diagramImage, diagramOriginalImage: undefined, diagramSource: "extracted", diagramBox: cropSelection, geogebraBase64: undefined, geogebraPlan: undefined, vectorDiagramSvg: undefined, vectorDiagramPlan: undefined, diagramReconstructionConfidence: undefined, diagramVisualFitScore: undefined, diagramReconstructionWarnings: undefined, diagramReconstructedAt: undefined }); setCropDialog(false); setNotice("配图已重新裁剪");
  }

  async function persistQuestion() {
    if (fileImportSavingRef.current) return;
    if (!questionDraft || !questionDraft.stem.trim() || (!questionDraft.categoryId && !saveTemporaryQuestions)) { setNotice("请填写题干并选择分类", "error"); return; }
    const tagVersions = alevelTagVersions(questionDraft);
    if (questionDraftIsAlevel && tagVersions.zh.length !== tagVersions.en.length) { setNotice("请让中文和 English 知识点一一对应；不填写时两边都留空", "error"); return; }
    const timestamp = currentTimestamp();
    const saved: Question = { ...questionDraft, id: questionDraft.id || uid("q"), moduleId: questionDraftModule?.id || questionDraft.moduleId, examYear: questionDraft.examYear?.trim(), stem: questionDraft.stem.trim(), options: questionDraft.options.map((item) => item.trim()).filter(Boolean), ...(questionDraftIsAlevel ? { tags: tagVersions.zh, tagsZh: tagVersions.zh, tagsEn: tagVersions.en } : {}), createdAt: questionDraft.createdAt || timestamp, updatedAt: timestamp };
    fileImportSavingRef.current = true; setIsSavingImportedQuestions(true);
    try {
      if (saveTemporaryQuestions) {
        const question = questionDraft.id ? saved : (await createCloudQuestion(saved)).question;
        onSaved(await saveTemporaryQuestions([question])); setNotice(questionDraft.id ? "临时题目已保存" : "题目已分配 ID 并加入正式题库"); onClose(); return;
      }
      const result = questionDraft.id && !addToLibrary ? await updateCloudQuestion(saved) : await createCloudQuestion(saved);
      onSaved([result.question]); setNotice(addToLibrary ? `已加入题库${result.question.code ? `，ID ${result.question.code} 不变` : ""}` : questionDraft.id ? "云端试题已更新" : "试题已保存到云端"); onClose();
    } catch (error) { setNotice(error instanceof Error ? error.message : "试题保存失败", "error"); }
    finally { fileImportSavingRef.current = false; setIsSavingImportedQuestions(false); }
  }

  return <>
    {questionDraft && !fileImportOpen && <div className="modal-backdrop">
      <section className="modal question-modal" role="dialog" aria-modal="true" aria-label="试题编辑" onPaste={(event) => { const file = clipboardImage(event); if (file) { event.preventDefault(); if (screenshotEntry) handleQuestionImage(file); else handleManualImages([file]); } }}>
        <div className="modal-head"><div><span className="eyebrow">智能录题</span><h2>{addToLibrary ? "加入题库" : questionDraft.id ? "编辑并校对试题" : "截图自动录题"}</h2></div><button className="close" disabled={isSavingImportedQuestions} onClick={onClose}>×</button></div>
        {!questionDraft.id && <div className="entry-mode" role="tablist" aria-label="录题方式"><button className="active"><b>AI 截图录入</b><span>识别单道题目截图</span></button><button onClick={openFileImport}><b>文件批量录入</b><span>PDF / Word 整份导入</span></button></div>}
        {screenshotEntry && (!questionDraft.originalImage ? <button type="button" className="smart-capture" onClick={() => questionImageRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = droppedImage(event); if (file) handleQuestionImage(file); else setRecognitionError("请选择图片文件"); }}>
          <div className="capture-icon">⌘V</div><div><b>直接粘贴题目截图</b><p>也可以点击选择图片，或把图片拖到这里</p></div><span>自动识别题干、公式、答案与配图</span>
        </button> : <div className="recognition-source">
          <div className="source-image"><img src={questionDraft.originalImage} alt="原始题目截图" />{isRecognizing && <div className="recognizing"><i></i><b>正在识别题目…</b><span>文字、公式和配图会自动拆分</span></div>}</div>
          <div className="source-status"><span className="eyebrow">原始截图已保留</span><b>{isReconstructingDiagram ? "正在提取原图轮廓并生成矢量稿" : isRecognizing ? "识别处理中" : questionDraft.recognitionConfidence != null ? `识别可信度 ${Math.round(questionDraft.recognitionConfidence * 100)}%` : "等待识别"}</b><p>下面的结果可以逐项修改，保存后仍可对照原图。</p><div><button className="secondary" disabled={isRecognizing || isReconstructingDiagram} onClick={() => recognizeImage(questionDraft.originalImage!)}>重新识别</button><button className="text-button" onClick={() => setQuestionDraft({ ...questionDraft, originalImage: undefined, contentImages: [], diagramImage: undefined, optionsImage: undefined, diagramOriginalImage: undefined, diagramSource: undefined, diagramQuality: undefined, diagramBox: undefined, geogebraBase64: undefined, geogebraPlan: undefined, vectorDiagramSvg: undefined, vectorDiagramPlan: undefined, diagramReconstructionConfidence: undefined, diagramVisualFitScore: undefined, diagramReconstructionWarnings: undefined, diagramReconstructedAt: undefined, recognitionConfidence: undefined, recognitionWarnings: [] })}>移除图片</button></div></div>
        </div>)}
        <input ref={questionImageRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) handleQuestionImage(file); event.target.value = ""; }} />
        <input ref={manualImagesRef} hidden multiple type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { handleManualImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        {screenshotEntry && recognitionError && <div className="recognition-error"><b>暂时无法自动识别</b><span>{recognitionError}</span></div>}
        {screenshotEntry && !!questionDraft.recognitionWarnings?.length && <div className="recognition-warning"><b>请重点核对</b><span>{questionDraft.recognitionWarnings.join("；")}</span></div>}
        <div className="review-divider"><span>{screenshotEntry ? "识别结果 · 保存前请检查" : "题目内容"}</span></div>
        <div className="form-grid two"><label>题型<select value={questionDraft.type} onChange={(event) => setQuestionDraft({ ...questionDraft, type: event.target.value as QuestionType })}>{questionTypes.map((item) => <option key={item}>{item}</option>)}</select></label><label>难度<select value={questionDraft.difficulty} onChange={(event) => setQuestionDraft({ ...questionDraft, difficulty: event.target.value as Difficulty })}>{difficulties.map((item) => <option key={item}>{item}</option>)}</select></label></div>
        <div className="form-grid two"><label>所属分类<select value={questionDraft.categoryId} onChange={(event) => setQuestionDraft({ ...questionDraft, categoryId: event.target.value })}><option value="">请选择</option>{categoryOptions}</select></label><label>年份 / 场次（选填）<input value={questionDraft.examYear ?? ""} onChange={(event) => setQuestionDraft({ ...questionDraft, examYear: event.target.value })} placeholder="如：2025 第一场" /></label></div>
        <div className="field"><span>题干</span><TextField value={questionDraft.stem} label="题干" placeholder="识别后的题干会出现在这里，也可以直接输入…" onChange={(stem) => setQuestionDraft((current) => current ? { ...current, stem, stemParagraphs: undefined, stemDocxXml: undefined, stemDocxAssets: undefined } : current)} /></div>
        {!screenshotEntry && <div className="manual-image-editor" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handleManualImages(Array.from(event.dataTransfer.files)); }}>
          <div className="manual-image-head"><div><span className="eyebrow">题目配图（选填）</span><p>可添加几何图、函数图像或表格，最多 4 张；也支持直接粘贴。</p></div><button className="secondary" onClick={() => manualImagesRef.current?.click()}>＋ 添加图片</button></div>
          {manualImages.length ? <div className="manual-image-grid">{manualImages.map((image, index) => <figure key={`manual-${index}`}><img src={image} alt={`人工添加的题目配图 ${index + 1}`} /><button aria-label={`移除第 ${index + 1} 张配图`} onClick={() => setQuestionDraft({ ...questionDraft, contentImages: questionDraft.contentImages?.filter((source) => source !== image) })}>×</button><figcaption>配图 {index + 1}</figcaption></figure>)}</div> : <button className="manual-image-empty" onClick={() => manualImagesRef.current?.click()}><span>＋</span> 点击、拖入或粘贴题目配图</button>}
        </div>}
        {screenshotEntry && questionDraft.diagramImage && (questionDraft.diagramSource === "svg-ai" && questionDraft.diagramOriginalImage ? <div className="diagram-review geogebra-review"><div><span className="eyebrow">原图坐标高清矢量重绘</span><p>最终图直接使用原图坐标，不再由几何引擎重新摆点。综合视觉匹配度 {Math.round((questionDraft.diagramVisualFitScore ?? 0) * 100)}%，关系识别可信度 {Math.round((questionDraft.diagramReconstructionConfidence ?? 0) * 100)}%。</p></div><div className="diagram-compare"><figure><img src={questionDraft.diagramOriginalImage} alt="重绘前的原始配图" /><figcaption>原始配图</figcaption></figure><figure><img src={questionDraft.diagramImage} alt="高清矢量重绘配图" /><figcaption>高清矢量重绘</figcaption></figure></div><div className="diagram-actions"><button className="secondary" disabled={isReconstructingDiagram} onClick={reconstructCurrentDiagram}>{isReconstructingDiagram ? "正在重绘…" : "重新渲染"}</button><button className="text-button" onClick={() => setQuestionDraft({ ...questionDraft, diagramImage: questionDraft.diagramOriginalImage, diagramOriginalImage: undefined, diagramSource: "extracted", vectorDiagramSvg: undefined, vectorDiagramPlan: undefined, diagramReconstructionConfidence: undefined, diagramVisualFitScore: undefined, diagramReconstructionWarnings: undefined, diagramReconstructedAt: undefined })}>使用原图</button></div></div> : <div className="diagram-review"><div><span className="eyebrow">清理后的独立配图</span><p>{isReconstructingDiagram ? "正在提取原图轮廓、标签位置和视觉比例…" : "已自动从截图中分离，保存后只展示这张图。"}</p></div><img src={questionDraft.diagramImage} alt="识别出的题目配图" /><div className="diagram-actions"><button className="secondary" onClick={beginManualCrop}>手动框选</button>{questionDraft.diagramQuality?.reconstructable && <button className="secondary" disabled={isReconstructingDiagram} onClick={reconstructCurrentDiagram}>高清矢量重绘</button>}<button className="text-button" onClick={() => setQuestionDraft({ ...questionDraft, diagramImage: undefined, diagramBox: undefined, diagramOriginalImage: undefined, diagramSource: undefined, vectorDiagramSvg: undefined, vectorDiagramPlan: undefined, diagramReconstructionConfidence: undefined, diagramVisualFitScore: undefined, diagramReconstructionWarnings: undefined, diagramReconstructedAt: undefined })}>移除</button></div></div>)}
        {!!questionImages(questionDraft).length && <div className="layout-choice"><div><span className="eyebrow">图文排列</span><p>{questionDraft.stemDocxXml?.length ? "文件录入题会按篇幅、分问和配图数量自动选择合适结构。" : questionDraft.originalImage && questionDraft.diagramBox ? "截图录入题按原图中配图的位置和大小排列。" : isGeometryQuestion(questionDraft) ? "网页端题干左、配图右；导出 Word 时自动改为题干下、配图右。" : "网页端可左右展示以节省空间，Word 导出会使用更稳妥的上下结构。"}</p></div><div>{questionDraft.stemDocxXml?.length || (questionDraft.originalImage && questionDraft.diagramBox) ? <button className="active">{resolveQuestionImageLayout(questionDraft) === "right" ? "网页 · 题干左配图右" : resolveQuestionImageLayout(questionDraft) === "below-right" ? "网页 · 题干上配图右下" : "网页 · 题干上配图左下"}</button> : isGeometryQuestion(questionDraft) ? <button className="active">网页 · 题干左配图右</button> : <><button className={(questionDraft.imageLayout ?? "right") === "right" ? "active" : ""} onClick={() => setQuestionDraft({ ...questionDraft, imageLayout: "right" })}>题干左 · 配图右</button><button className={questionDraft.imageLayout === "below" ? "active" : ""} onClick={() => setQuestionDraft({ ...questionDraft, imageLayout: "below" })}>题干上 · 配图下</button></>}</div></div>}
        {questionDraft.optionsImage && <div className="field options-figure-field"><span>选项（图）</span><figure><img src={questionDraft.optionsImage} alt="选项图" /><button className="text-button" onClick={() => setQuestionDraft({ ...questionDraft, optionsImage: undefined, options: questionDraft.options.length ? questionDraft.options : ["", "", "", ""] })}>移除选项图</button></figure></div>}
        {["单选题", "多选题"].includes(questionDraft.type) && !questionDraft.optionsImage && <div className="field"><span>选项</span>{questionDraft.optionsDocxXml?.length && Object.keys(questionDraft.optionsDocxAssets ?? {}).length ? <DocxOptions xml={questionDraft.optionsDocxXml} fallback={questionDraft.options} assets={questionDraft.optionsDocxAssets} /> : <div className="option-inputs">{questionDraft.options.map((option, index) => <div className="option-input" key={index}><b>{String.fromCharCode(65 + index)}</b><TextField singleLine value={option} label={`选项 ${String.fromCharCode(65 + index)}`} placeholder={`选项 ${String.fromCharCode(65 + index)}`} onChange={(value) => setQuestionDraft((current) => { if (!current) return current; const options = [...current.options]; options[index] = value; return { ...current, options, optionsDocxXml: undefined, optionsDocxAssets: undefined }; })} /></div>)}</div>}</div>}
        <div className="form-grid two"><div className="field"><span>答案</span><TextField singleLine value={questionDraft.answer} label="答案" placeholder="如：B 或 √5" onChange={(answer) => setQuestionDraft((current) => current ? { ...current, answer } : current)} /></div><label>详细来源（选填）<input value={questionDraft.source} onChange={(event) => setQuestionDraft({ ...questionDraft, source: event.target.value })} placeholder={`如：${questionDraftModule?.name ?? "当前模块"}回忆版 · 第 12 题`} /></label></div>
        {questionDraftIsAlevel ? <div className="bilingual-tag-fields">
          <label className="field"><span>中文知识点</span><input aria-label="中文知识点标签" value={alevelTagVersions(questionDraft).zh.join("，")} onChange={(event) => { const tagsZh = parseTagInput(event.target.value); setQuestionDraft({ ...questionDraft, tags: tagsZh, tagsZh }); }} placeholder="如：三角函数应用" /></label>
          <label className="field"><span>English topics</span><input aria-label="English topic tags" lang="en" value={alevelTagVersions(questionDraft).en.join(", ")} onChange={(event) => setQuestionDraft({ ...questionDraft, tagsEn: parseTagInput(event.target.value) })} placeholder="e.g. Modelling with Trigonometric Functions" /></label>
          <p>两边按相同顺序一一对应；截图识别后也请在保存前校对。</p>
        </div> : <label className="field">知识点标签（用逗号分隔）<input value={(questionDraft.tags ?? []).join("，")} onChange={(event) => setQuestionDraft({ ...questionDraft, tags: parseTagInput(event.target.value) })} placeholder="如：手拉手模型，旋转型全等" /></label>}
        <div className="field"><span>解析（选填）</span><TextField value={questionDraft.analysis} label="解析" placeholder="截图中有解析时会自动识别，也可以手工补充…" onChange={(analysis) => setQuestionDraft((current) => current ? { ...current, analysis, analysisDocxXml: undefined, analysisDocxAssets: undefined } : current)} /></div>
        {optimizationError && <div className="recognition-error"><b>AI 优化未完成</b><span>{optimizationError}</span></div>}
        {optimizationPreview && <section className="optimization-preview">
          <div className="optimization-title"><div><span className="eyebrow">AI 优化预览</span><h3>确认无误后再采用</h3></div><span className="layout-recommendation">网页建议：{optimizationPreview.image_layout === "right" ? "题干左 · 配图右" : optimizationPreview.image_layout === "below-right" ? "题干上 · 配图右下" : "题干上 · 配图左下"}</span></div>
          <div className="optimization-compare"><div><b>优化前</b><p><MathText text={questionDraft.stem} /></p></div><div><b>优化后</b><p><MathText text={optimizationPreview.stem} /></p></div></div>
          <div className="optimization-changes"><b>本次调整</b><span>{optimizationPreview.changes.join("；")}</span></div>
          <div className="optimization-actions"><button className="text-button" onClick={() => setOptimizationPreview(null)}>暂不采用</button><button className="primary-button" onClick={applyOptimization}>采用优化结果</button></div>
        </section>}
        <div className="modal-actions"><button className="ai-button" disabled={isSavingImportedQuestions || isRecognizing || isOptimizing || isReconstructingDiagram} onClick={optimizeDraft}>{isOptimizing ? <><i></i>AI 正在优化…</> : "✦ AI 优化排版"}</button><button className="secondary" disabled={isSavingImportedQuestions} onClick={onClose}>取消</button><button className="primary-button" disabled={isSavingImportedQuestions || isRecognizing || isOptimizing || isReconstructingDiagram} onClick={persistQuestion}>{isSavingImportedQuestions ? "正在保存…" : "确认并保存"}</button></div>
      </section>
    </div>}

    {fileImportOpen && <div className="modal-backdrop"><section className="modal file-import-modal" role="dialog" aria-modal="true" aria-label="文件批量录入" aria-busy={isSavingImportedQuestions}>
      <div className="modal-head"><div><span className="eyebrow">{saveTemporaryQuestions ? "临时题库" : "智能录题"}</span><h2>PDF / Word / 图片批量录入</h2></div><button className="close" disabled={isSavingImportedQuestions} onClick={closeFileImport}>×</button></div>
      {fileImportStep === "choose" && <>
        <div className="entry-mode" role="tablist" aria-label="录题方式"><button onClick={backToScreenshotEntry}><b>AI 截图录入</b><span>识别单道题目截图</span></button><button className="active"><b>文件批量录入</b><span>PDF / Word 整份导入</span></button></div>
        <div className="file-import-intro"><div><b>整份文件导入</b><p>能读出结构的 Word 直接进入校对；PDF、图片和读不出结构的 Word 交给 AI 在后台逐页识别，上传完就可以关闭窗口，识别完在下面的识别任务里打开校对。</p></div></div>
        <button className="file-dropzone" onClick={() => fileImportRef.current?.click()} onPaste={(event) => { const file = clipboardImage(event); if (file) { event.preventDefault(); void handleImportDocument(file); } }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) handleImportDocument(file); }}><strong>选择、拖入文件或粘贴图片</strong><span>支持 PDF、Word（.docx）、PNG / JPEG / WebP，单个文件最多 80MB</span><small>旧版 .doc 请先在 Word 中另存为 .docx</small></button>
        <input ref={fileImportRef} hidden type="file" accept="application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) handleImportDocument(file); event.target.value = ""; }} />
        {!!fileImportErrors.length && <div className="recognition-error"><b>文件未能读取</b><span>{fileImportErrors.join("；")}</span></div>}
        {fileImportNotice && <div className={fileImportNotice.error ? "recognition-error" : "recognition-warning"} role="status"><b>{fileImportNotice.error ? "操作未完成" : "已转入后台"}</b><span>{fileImportNotice.text}</span></div>}
        <RecognitionJobTable kind="import" jobs={imports.jobs} openJobId={openImportJobId} busy={false} cancellingJobId={imports.cancellingJobId} canOpen={(job) => job.status === "done" || job.status === "failed" && job.processedCount > 0}
          onOpen={(job) => void openImportJob(job)} onResume={(job) => void imports.resume(job)} onCancel={(job) => void imports.cancel(job)} onRemove={(job) => void imports.remove(job)} />
        <div className="file-privacy-note">{saveTemporaryQuestions ? "校对确认后自动分配 ID 并加入正式题库，同时保留在当前临时题库中供选题。" : "正式题库只保存你确认过的题目内容。"}交给 AI 识别的页面会上传到服务器，删除识别任务时一并删除。</div>
      </>}
      {(fileImportStep === "rendering" || fileImportStep === "recognizing") && <div className="file-processing"><div className="file-spinner"><i></i><span>{fileImportStep === "rendering" ? "读取文件" : "整理题目"}</span></div><h3>{fileImportProgress.label}</h3><div className="progress-track"><i style={{ width: `${fileImportProgress.total ? fileImportProgress.current / fileImportProgress.total * 100 : 8}%` }}></i></div><p>{fileImportStep === "rendering" ? "完成后自动进入下一步" : "正在拆分题干、选项、答案和配图"}</p><button className="secondary" onClick={closeFileImport}>取消导入</button></div>}
      {fileImportStep === "review" && <>
        <div className="file-review-summary"><div><strong>{fileImportDrafts.length}</strong><span>道待校对题目</span></div><p>{fileImportName} · 已选择 {fileImportDrafts.filter((item) => item.selected).length} 道</p><button className="secondary" disabled={isSavingImportedQuestions} onClick={() => setFileImportDrafts((current) => current.map((item) => ({ ...item, selected: !current.every((entry) => entry.selected) })))}>{fileImportDrafts.every((item) => item.selected) ? "取消全选" : "全部选择"}</button></div>
        {!!fileImportErrors.length && <div className="recognition-warning"><b>导入提示</b><span>{fileImportErrors.join("；")}</span></div>}
        {!fileImportDrafts.length ? <div className="file-empty-result"><b>没有识别到完整题目</b><p>请确认文件页面清晰且包含题号，再重新选择文件。</p><button className="secondary" onClick={() => setFileImportStep("choose")}>重新选择</button></div> : <div className="file-draft-list" inert={isSavingImportedQuestions}>{fileImportDrafts.map((item, index) => <article className={`file-draft ${item.selected ? "selected" : ""}`} key={item.importId}>
          <div className="file-draft-head"><label><input type="checkbox" checked={item.selected} onChange={(event) => updateImportDraft(item.importId, { selected: event.target.checked })} /><b>第 {index + 1} 题</b></label><span>{item.sourcePage ? `文件第 ${item.sourcePage} 页` : `Word 原题 ${item.documentNumber || index + 1}`} · 可信度 {Math.round((item.recognitionConfidence ?? 0) * 100)}%</span><button onClick={() => setFileImportDrafts((current) => current.filter((entry) => entry.importId !== item.importId))}>移除</button></div>
          <div className="file-draft-fields"><label>题型<select value={item.type} onChange={(event) => updateImportDraft(item.importId, { type: event.target.value as QuestionType })}>{questionTypes.map((type) => <option key={type}>{type}</option>)}</select></label><label>难度<select value={item.difficulty} onChange={(event) => updateImportDraft(item.importId, { difficulty: event.target.value as Difficulty })}>{difficulties.map((difficulty) => <option key={difficulty}>{difficulty}</option>)}</select></label><label className="wide">分类<select value={item.categoryId} onChange={(event) => updateImportDraft(item.importId, { categoryId: event.target.value })}><option value="">请选择</option>{categoryOptions}</select></label></div>
          <div className="field"><span>题干</span><TextField value={item.stem} label={`第 ${index + 1} 题题干`} onChange={(stem) => updateImportDraft(item.importId, { stem })} /></div>
          {!!(questionImages(item).length || item.optionsImage) && <div className="file-draft-media"><div className="file-draft-images">{[...questionImages(item), ...(item.optionsImage ? [item.optionsImage] : [])].map((image, imageIndex) => <img src={image} alt={`第 ${index + 1} 题配图 ${imageIndex + 1}`} key={`${item.importId}-preview-${imageIndex}`} />)}</div><span>{item.diagramSource === "svg-ai" ? `高清矢量重绘 · 视觉匹配度 ${Math.round((item.diagramVisualFitScore ?? 0) * 100)}%` : `已保留 ${questionImages(item).length} 张原始配图`}</span></div>}
          {!!importedDocxTableCount(item) && <div className="file-draft-structure">已保留 {importedDocxTableCount(item)} 个 Word 原表格，导出时沿用原行列与公式结构</div>}
          {item.type === "单选题" || item.type === "多选题" ? <div className="field"><span>{item.optionsDocxXml?.length && Object.keys(item.optionsDocxAssets ?? {}).length ? "选项" : "选项（每行一个）"}</span>{item.optionsDocxXml?.length && Object.keys(item.optionsDocxAssets ?? {}).length ? <DocxOptions xml={item.optionsDocxXml} fallback={item.options} assets={item.optionsDocxAssets} /> : <TextField value={item.options.join("\n")} label={`第 ${index + 1} 题选项`} onChange={(options) => updateImportDraft(item.importId, { options: options.split("\n") })} />}</div> : null}
          <div className="file-draft-answer"><div className="field"><span>答案</span><TextField singleLine value={item.answer} label={`第 ${index + 1} 题答案`} onChange={(answer) => updateImportDraft(item.importId, { answer })} /></div><label>来源<input value={item.source} onChange={(event) => updateImportDraft(item.importId, { source: event.target.value })} /></label></div>
          {isAlevelCategory(item.categoryId) ? <div className="file-draft-answer bilingual-file-tags"><label>中文知识点<input aria-label={`第 ${index + 1} 题中文知识点标签`} value={alevelTagVersions(item).zh.join("，")} onChange={(event) => { const tagsZh = parseTagInput(event.target.value); updateImportDraft(item.importId, { tags: tagsZh, tagsZh }); }} placeholder="如：一元二次方程" /></label><label>English topics<input lang="en" aria-label={`Question ${index + 1} English topic tags`} value={alevelTagVersions(item).en.join(", ")} onChange={(event) => updateImportDraft(item.importId, { tagsEn: parseTagInput(event.target.value) })} placeholder="e.g. Quadratic Equations" /></label></div> : <label className="field file-draft-tags">知识点标签（用逗号分隔）<input value={(item.tags ?? []).join("，")} onChange={(event) => updateImportDraft(item.importId, { tags: parseTagInput(event.target.value) })} /></label>}
          {!!item.recognitionWarnings?.length && <p className="file-draft-warning">请核对：{item.recognitionWarnings.join("；")}</p>}
        </article>)}</div>}
        <div className="modal-actions file-import-actions"><button className="secondary" disabled={isSavingImportedQuestions} onClick={() => setFileImportStep("choose")}>重新选择文件</button><button className="primary-button" disabled={isSavingImportedQuestions || !fileImportDrafts.some((item) => item.selected)} onClick={saveImportedQuestions}>{isSavingImportedQuestions ? "正在保存…" : `保存所选 ${fileImportDrafts.filter((item) => item.selected).length} 道题`}</button></div>
      </>}
      {imports.confirmNode}
    </section></div>}

    {cropDialog && questionDraft?.originalImage && <div className="modal-backdrop"><section className="modal crop-modal" role="dialog" aria-modal="true" aria-label="手动裁剪配图">
      <div className="modal-head"><div><span className="eyebrow">配图校正</span><h2>拖动框选完整图形</h2></div><button className="close" onClick={() => setCropDialog(false)}>×</button></div>
      <p className="crop-help">从配图左上角拖到右下角，只框选需要进入试卷的图形和字母标注。</p>
      <div ref={cropStageRef} className="crop-stage" onPointerDown={(event) => { const point = cropPoint(event); setCropStart(point); setCropSelection({ ...point, width: 0, height: 0 }); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!cropStart) return; const point = cropPoint(event); setCropSelection({ x: Math.min(cropStart.x, point.x), y: Math.min(cropStart.y, point.y), width: Math.abs(point.x - cropStart.x), height: Math.abs(point.y - cropStart.y) }); }} onPointerUp={() => setCropStart(null)}>
        <img src={questionDraft.originalImage} alt="原始题目截图，拖动选择配图" draggable={false} />
        {cropSelection && <div className="crop-selection" style={{ left: `${cropSelection.x / 10}%`, top: `${cropSelection.y / 10}%`, width: `${cropSelection.width / 10}%`, height: `${cropSelection.height / 10}%` }}><span></span><span></span><span></span><span></span></div>}
      </div>
      <div className="modal-actions"><button className="secondary" onClick={() => setCropDialog(false)}>取消</button><button className="primary-button" onClick={applyManualCrop}>使用这个范围</button></div>
    </section></div>}
  </>;
}
