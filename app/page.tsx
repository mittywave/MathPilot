"use client";

import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { DocxContent, DocxOptions } from "./components/DocxContent";
import { MathText } from "./components/MathText";
import { StudioSolution } from "./components/StudioSolution";
import { PaperMoreMenu } from "./components/PaperMoreMenu";
import { StudentArchiveTabs } from "./components/StudentArchiveTabs";
import { WrongQuestionEvidence } from "./components/WrongQuestionEvidence";
import { moveBasketQuestion, orderedBasketQuestions } from "../lib/paper-basket";
import { exportQuestionsToWord } from "../lib/export-word";
import { renderImportFile } from "../lib/file-import";
import { orderedImportTimestamp } from "../lib/question-order-rules.mjs";
import { clipboardImage, compressDataUrl, cropExactDataUrl, fileToDataUrl, imageAspectRatio, materializeImageDataUrl, type NormalizedBox } from "../lib/image-tools";
import { isPhotographedDiagram } from "../lib/image-processing-rules.mjs";
import { extractRecognizedDiagram, shouldReconstructRecognizedDiagram } from "../lib/recognition-diagram";
import type { BatchRecognitionResult, RecognitionQuestionResult } from "../lib/recognition-contract";
import { renderVectorDiagramPlan, VectorDiagramFitError } from "../lib/vector-diagram-renderer";
import { isCompactConclusionQuestion, isGeometryQuestion, questionImages, resolveQuestionImageLayout } from "../lib/question-layout";
import { cleanRecognizedAnalysis, cleanRecognizedAnswer } from "../lib/recognition-cleanup.mjs";
import { authorizeDownload, copyPublicQuestions, createCloudCategory, createCloudModule, createCloudQuestion, createStudent as createStudentProfile, deleteCloudCategory, deleteCloudModule, deleteCloudQuestion, deleteStudent as deleteStudentProfile, fetchLibrary, fetchMe, fetchStudents, fetchWrongQuestions, importCloudLibrary, login, logout, publishPublicLibrary, register, reorderCloudModules, updateCloudModule, updateCloudQuestion, updateStudent as updateStudentProfile, updateWrongQuestion, type PublicationProgress } from "../lib/api-client";
import { ALEVEL_PAGE_COPY, ALEVEL_PAGE_LOCALE_KEY, alevelPageLabel, alevelQuestionCount, alevelTagVersions, isAlevel9709ModuleName, localizeAlevelTags, type AlevelPageLocale } from "../lib/alevel-page-locale.mjs";
import { normalizeQuestionProvenance, QUESTION_PROVENANCES } from "../lib/exam-modules.mjs";
import type { AuthUser, Category, DiagramQuality, Difficulty, ImageLayout, LibraryData, LibraryModule, LibraryScope, Question, QuestionProvenance, QuestionType, Student, StudentSummary, VectorDiagramPlan, WrongQuestionEntry } from "../lib/types";

const questionTypes: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];
const difficulties: Difficulty[] = ["基础", "中等", "提高"];
const emptyDraft = (): Question => ({ id: "", categoryId: "", type: "单选题", difficulty: "基础", provenance: "来源待核实", examYear: "", stem: "", options: ["", "", "", ""], answer: "", analysis: "", source: "", createdAt: 0, updatedAt: 0 });

type OptimizationResult = {
  stem: string; options: string[]; answer: string; analysis: string; source: string; tags: string[];
  image_layout: ImageLayout; changes: string[];
};
type FileImportDraft = Question & { importId: string; selected: boolean; documentNumber: string };
type FileImportStep = "choose" | "rendering" | "recognizing" | "review";
type ColorTheme = "light" | "dark";

const FILE_IMPORT_CONCURRENCY = 2;
const FILE_IMPORT_MAX_ATTEMPTS = 2;
const RETRYABLE_IMPORT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function uid(prefix: string) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
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

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex; nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

export default function Home() {
  const [colorTheme, setColorTheme] = useState<ColorTheme>("light");
  const [alevelPageLocale, setAlevelPageLocale] = useState<AlevelPageLocale>("zh");
  const [libraryScope, setLibraryScope] = useState<LibraryScope>("public");
  const [modules, setModules] = useState<LibraryModule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [activeModuleId, setActiveModuleId] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [selectedByScope, setSelectedByScope] = useState<Record<LibraryScope, string[]>>({ public: [], mine: [] });
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"全部" | QuestionType>("全部");
  const [provenanceFilter, setProvenanceFilter] = useState<"全部" | QuestionProvenance>("全部");
  const [showSelected, setShowSelected] = useState(false);
  const [expandedAnswers, setExpandedAnswers] = useState<string[]>([]);
  const [questionDraft, setQuestionDraft] = useState<Question | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<"new" | "manage" | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryParent, setCategoryParent] = useState<string>("");
  const [exportDialog, setExportDialog] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [paperTitle, setPaperTitle] = useState("专项练习");
  const [includeAnswers, setIncludeAnswers] = useState(true);
  const [notice, setNotice] = useState("");
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authDialog, setAuthDialog] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authInvite, setAuthInvite] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [isReconstructingDiagram, setIsReconstructingDiagram] = useState(false);
  const [enableVectorReconstruction, setEnableVectorReconstruction] = useState(true);
  const [recognitionError, setRecognitionError] = useState("");
  const [entryMode, setEntryMode] = useState<"manual" | "screenshot">("manual");
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizationError, setOptimizationError] = useState("");
  const [optimizationPreview, setOptimizationPreview] = useState<OptimizationResult | null>(null);
  const [cropDialog, setCropDialog] = useState(false);
  const [cropSelection, setCropSelection] = useState<NormalizedBox | null>(null);
  const [cropStart, setCropStart] = useState<{ x: number; y: number } | null>(null);
  const [fileImportOpen, setFileImportOpen] = useState(false);
  const [fileImportStep, setFileImportStep] = useState<FileImportStep>("choose");
  const [fileImportName, setFileImportName] = useState("");
  const [fileImportCategory, setFileImportCategory] = useState("");
  const [fileImportProgress, setFileImportProgress] = useState({ current: 0, total: 0, label: "" });
  const [fileImportDrafts, setFileImportDrafts] = useState<FileImportDraft[]>([]);
  const [fileImportErrors, setFileImportErrors] = useState<string[]>([]);
  const [moduleDialog, setModuleDialog] = useState<"new" | "manage" | null>(null);
  const [moduleDraft, setModuleDraft] = useState<LibraryModule | null>(null);
  const [moduleName, setModuleName] = useState("");
  const [moduleSubtitle, setModuleSubtitle] = useState("");
  const [draggedModuleId, setDraggedModuleId] = useState("");
  const [deleteModuleTarget, setDeleteModuleTarget] = useState<LibraryModule | null>(null);
  const [deleteModuleConfirmation, setDeleteModuleConfirmation] = useState("");
  const [copyDialog, setCopyDialog] = useState(false);
  const [copyTargetData, setCopyTargetData] = useState<LibraryData | null>(null);
  const [copyTargetModule, setCopyTargetModule] = useState("");
  const [copyTargetCategory, setCopyTargetCategory] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [publicationProgress, setPublicationProgress] = useState<PublicationProgress | null>(null);
  const [publicationFailed, setPublicationFailed] = useState(false);
  const [publishedAt, setPublishedAt] = useState<number | null>(null);
  const [showWrongBook, setShowWrongBook] = useState(false);
  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [activeStudentId, setActiveStudentId] = useState("");
  const [wrongEntries, setWrongEntries] = useState<WrongQuestionEntry[]>([]);
  const [wrongBookLoading, setWrongBookLoading] = useState(false);
  const [studentDialog, setStudentDialog] = useState(false);
  const [studentDraft, setStudentDraft] = useState<Student | null>(null);
  const [studentName, setStudentName] = useState("");
  const [studentClassName, setStudentClassName] = useState("");
  const [studentNotes, setStudentNotes] = useState("");
  const [wrongEntryDraft, setWrongEntryDraft] = useState<WrongQuestionEntry | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const questionImageRef = useRef<HTMLInputElement>(null);
  const manualImagesRef = useRef<HTMLInputElement>(null);
  const fileImportRef = useRef<HTMLInputElement>(null);
  const cropStageRef = useRef<HTMLDivElement>(null);
  const fileImportAbortRef = useRef<AbortController | null>(null);
  const activeModule = modules.find((item) => item.id === activeModuleId) ?? modules[0] ?? null;
  const isAlevelPage = !showWrongBook && !showSelected && isAlevel9709ModuleName(activeModule?.name);
  const questionDraftModule = questionDraft ? modules.find((item) => item.id === questionDraft.moduleId) ?? activeModule : activeModule;
  const questionDraftIsAlevel = Boolean(questionDraft && isAlevel9709ModuleName(questionDraftModule?.name));
  const pageLocale: AlevelPageLocale = isAlevelPage ? alevelPageLocale : "zh";
  const pageCopy = ALEVEL_PAGE_COPY[pageLocale];
  const selectedIds = selectedByScope[libraryScope];
  const canManageLibrary = Boolean(authUser && (libraryScope === "mine" || authUser.local));
  const activeStudent = students.find((item) => item.id === activeStudentId) ?? null;

  function setSelectedIds(updater: string[] | ((current: string[]) => string[])) {
    setSelectedByScope((current) => ({
      ...current,
      [libraryScope]: typeof updater === "function" ? updater(current[libraryScope]) : updater,
    }));
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setColorTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
      try { setAlevelPageLocale(window.localStorage.getItem(ALEVEL_PAGE_LOCALE_KEY) === "en" ? "en" : "zh"); } catch { /* 本地存储不可用时保持中文默认值 */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function chooseColorTheme(theme: ColorTheme) {
    setColorTheme(theme);
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem("mitty-color-theme", theme); } catch { /* 浏览器禁用本地存储时仍保留本次切换 */ }
  }

  function chooseAlevelPageLocale(locale: AlevelPageLocale) {
    setAlevelPageLocale(locale);
    try { window.localStorage.setItem(ALEVEL_PAGE_LOCALE_KEY, locale); } catch { /* 本地存储不可用时仍保留本次切换 */ }
  }

  function applyLibrary(data: LibraryData, preserveCategory = true) {
    const sortedModules = [...data.modules].sort((left, right) => left.sortOrder - right.sortOrder);
    setModules(sortedModules);
    setCategories(data.categories.sort((a, b) => a.createdAt - b.createdAt));
    setQuestions(data.questions.sort((a, b) => b.createdAt - a.createdAt));
    setPublishedAt(data.publishedAt ?? null);
    const availableIds = new Set([...sortedModules.map((item) => item.id), ...data.categories.map((item) => item.id)]);
    const nextModule = sortedModules.find((item) => item.id === activeModuleId) ?? sortedModules[0] ?? null;
    setActiveModuleId(nextModule?.id ?? "");
    setActiveCategory((current) => preserveCategory && current && availableIds.has(current) ? current : nextModule?.id ?? null);
    if (nextModule && !selectedIds.length) setPaperTitle(`${nextModule.name}专项练习`);
  }

  async function refreshLibrary(preserveCategory = true, scope = libraryScope) {
    const data = await fetchLibrary(scope);
    applyLibrary(data, preserveCategory);
  }

  useEffect(() => {
    void (async () => {
      try {
        const auth = await fetchMe();
        const params = new URLSearchParams(window.location.search);
        const requestedScope: LibraryScope = auth.user && params.get("scope") === "mine" ? "mine" : "public";
        const data = await fetchLibrary(requestedScope);
        setAuthUser(auth.user); setLibraryScope(requestedScope); applyLibrary(data, false);
        if (auth.user && params.get("view") === "wrong-book") {
          setShowWrongBook(true); setWrongBookLoading(true);
          try { await loadStudents(params.get("studentId") ?? ""); } finally { setWrongBookLoading(false); }
        } else if (auth.user && params.get("view") === "selected") setShowSelected(true);
      } catch { setNotice("云端题库读取失败，请刷新页面重试"); }
      finally { setAuthLoading(false); }
    })();
  // The initial URL view is intentionally read once; later switches are handled by page actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2600); return () => clearTimeout(timer); }, [notice]);

  const childrenOf = (id: string | null) => categories.filter((item) => item.parentId === id);
  const descendantsOf = (id: string): string[] => {
    const direct = childrenOf(id);
    return [id, ...direct.flatMap((item) => descendantsOf(item.id))];
  };
  const categoryById = (id: string | null) => categories.find((item) => item.id === id);
  const moduleById = (id: string | null) => modules.find((item) => item.id === id);
  const pathOf = (id: string) => {
    const directModule = moduleById(id); if (directModule) return directModule.name;
    const names: string[] = []; let current = categoryById(id); let guard = 0;
    while (current && guard < 20) {
      names.unshift(current.name);
      const parentModule = moduleById(current.parentId);
      if (parentModule) { names.unshift(parentModule.name); break; }
      current = categoryById(current.parentId); guard += 1;
    }
    return names.join(" / ");
  };
  const countFor = (id: string) => moduleById(id)
    ? questions.filter((question) => question.moduleId === id).length
    : questions.filter((question) => descendantsOf(id).includes(question.categoryId)).length;
  const moduleCategories = activeModule ? categories.filter((item) => item.moduleId === activeModule.id) : [];
  const moduleQuestions = activeModule ? questions.filter((item) => item.moduleId === activeModule.id) : [];
  const activeCategoryIds = activeCategory ? descendantsOf(activeCategory) : activeModule ? [activeModule.id, ...moduleCategories.map((item) => item.id)] : [];
  const categoryQuestions = moduleQuestions.filter((item) => activeCategoryIds.includes(item.categoryId));

  function switchExamModule(moduleId: string) {
    const targetModule = modules.find((item) => item.id === moduleId); if (!targetModule) return;
    setActiveModuleId(targetModule.id);
    setActiveCategory(targetModule.id);
    if (!selectedIds.length) setPaperTitle(`${targetModule.name}专项练习`);
    setProvenanceFilter("全部");
    setTypeFilter("全部");
    setQuery("");
    setShowSelected(false);
    setShowWrongBook(false);
  }

  const selectedQuestions = orderedBasketQuestions(questions, selectedIds);
  const filteredQuestions = useMemo(() => {
    if (showSelected) return orderedBasketQuestions(questions, selectedIds);
    let result = questions;
    if (activeCategory) { const allowed = descendantsOf(activeCategory); result = result.filter((item) => allowed.includes(item.categoryId)); }
    if (provenanceFilter !== "全部") result = result.filter((item) => normalizeQuestionProvenance(item.provenance) === provenanceFilter);
    if (typeFilter !== "全部") result = result.filter((item) => item.type === typeFilter);
    const keyword = query.trim().toLowerCase();
    if (keyword) result = result.filter((item) => `${item.stem} ${item.answer} ${item.analysis} ${item.source} ${item.examYear ?? ""} ${normalizeQuestionProvenance(item.provenance)} ${(item.tags ?? []).join(" ")} ${(item.tagsZh ?? []).join(" ")} ${(item.tagsEn ?? []).join(" ")} ${pathOf(item.categoryId)}`.toLowerCase().includes(keyword));
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions, categories, activeCategory, showSelected, provenanceFilter, typeFilter, query, selectedIds]);

  const allFilteredSelected = filteredQuestions.length > 0 && filteredQuestions.every((item) => selectedIds.includes(item.id));
  const activeName = showSelected ? "我的组卷" : activeCategory ? moduleById(activeCategory)?.name ?? categoryById(activeCategory)?.name ?? pageCopy.allQuestions : pageCopy.allQuestions;
  const activeWrongEntries = wrongEntries.filter(entry => entry.archivedAt == null);
  const historicalWrongEntries = wrongEntries.filter(entry => entry.archivedAt != null);
  const filteredWrongEntries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return wrongEntries.filter(entry => entry.archivedAt == null);
    return wrongEntries.filter(entry => entry.archivedAt == null).filter((entry) => `${entry.question.stem} ${entry.question.answer} ${entry.question.analysis} ${entry.question.source} ${entry.sourcePath} ${entry.note}`.toLowerCase().includes(keyword));
  }, [query, wrongEntries]);

  const requireLogin = () => { if (authUser) return true; setAuthMode("login"); setAuthDialog(true); setAuthError("请先登录后再使用这项功能"); return false; };
  async function switchLibraryScope(scope: LibraryScope) {
    if (scope === libraryScope && !showWrongBook) { setShowSelected(false); return; }
    if (scope === "mine" && !requireLogin()) return;
    try {
      const data = await fetchLibrary(scope);
      setLibraryScope(scope); setShowSelected(false); setShowWrongBook(false); setQuery(""); setTypeFilter("全部"); setProvenanceFilter("全部");
      applyLibrary(data, false);
    } catch (error) { setNotice(error instanceof Error ? error.message : "题库切换失败"); }
  }

  async function loadStudents(preferredStudentId = activeStudentId) {
    const result = await fetchStudents();
    setStudents(result.students);
    const nextId = result.students.some((item) => item.id === preferredStudentId) ? preferredStudentId : result.students[0]?.id ?? "";
    setActiveStudentId(nextId);
    if (nextId) {
      const wrong = await fetchWrongQuestions(nextId);
      setWrongEntries(wrong.entries);
    } else setWrongEntries([]);
    return result.students;
  }

  async function openWrongBook() {
    if (!requireLogin()) return;
    setShowWrongBook(true); setShowSelected(false); setQuery(""); setWrongBookLoading(true);
    try { await loadStudents(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "错题本读取失败"); }
    finally { setWrongBookLoading(false); }
  }

  async function selectStudent(id: string) {
    setActiveStudentId(id); setWrongBookLoading(true); setQuery("");
    try { setWrongEntries((await fetchWrongQuestions(id)).entries); }
    catch (error) { setNotice(error instanceof Error ? error.message : "错题记录读取失败"); }
    finally { setWrongBookLoading(false); }
  }

  function openStudentDialog(student?: Student) {
    setStudentDraft(student ?? null); setStudentName(student?.name ?? ""); setStudentClassName(student?.className ?? ""); setStudentNotes(student?.notes ?? ""); setStudentDialog(true);
  }

  async function saveStudent() {
    if (!studentName.trim()) { setNotice("请填写学生姓名或昵称"); return; }
    try {
      const payload = { name: studentName, className: studentClassName, notes: studentNotes };
      const result = studentDraft
        ? await updateStudentProfile({ ...studentDraft, ...payload })
        : await createStudentProfile(payload);
      setStudentDialog(false); await loadStudents(result.student.id);
      setNotice(studentDraft ? "学生档案已更新" : `已创建学生档案：${result.student.name}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "学生档案保存失败"); }
  }

  async function removeStudent(student: StudentSummary) {
    if (!window.confirm(`删除“${student.name}”及其 ${student.wrongCount} 道错题记录？此操作无法撤销。`)) return;
    try {
      await deleteStudentProfile(student.id); await loadStudents(activeStudentId === student.id ? "" : activeStudentId);
      setNotice(`已删除学生档案：${student.name}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "学生档案删除失败"); }
  }

  async function saveWrongEntry() {
    if (!wrongEntryDraft) return;
    try {
      await updateWrongQuestion(wrongEntryDraft.studentId, wrongEntryDraft.id, { note: wrongEntryDraft.note, mastered: wrongEntryDraft.mastered });
      setWrongEntryDraft(null); await loadStudents(wrongEntryDraft.studentId); setNotice("错题复习记录已更新");
    } catch (error) { setNotice(error instanceof Error ? error.message : "错题记录更新失败"); }
  }

  async function toggleWrongMastery(entry: WrongQuestionEntry) {
    try {
      await updateWrongQuestion(entry.studentId, entry.id, { mastered: !entry.mastered });
      await loadStudents(entry.studentId); setNotice(entry.mastered ? "已恢复为复习中" : "已标记为掌握");
    } catch (error) { setNotice(error instanceof Error ? error.message : "错题状态更新失败"); }
  }


  const toggleSelected = (id: string) => { if (!requireLogin()) return; setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); };
  const toggleAllFiltered = () => {
    if (!requireLogin()) return;
    const visibleIds = filteredQuestions.map((item) => item.id);
    setSelectedIds((current) => allFilteredSelected ? current.filter((id) => !visibleIds.includes(id)) : [...current, ...visibleIds.filter((id) => !current.includes(id))]);
  };
  const openNewQuestion = () => { if (!requireLogin() || !canManageLibrary) return; if (!activeModule) { setModuleDialog("new"); return; } setRecognitionError(""); setOptimizationError(""); setOptimizationPreview(null); setEntryMode("manual"); setQuestionDraft({ ...emptyDraft(), moduleId: activeModule.id, categoryId: activeCategory ?? activeModule.id, imageLayout: "right", contentImages: [], ...(isAlevel9709ModuleName(activeModule.name) ? { tags: [], tagsZh: [], tagsEn: [] } : {}) }); };
  const openEditQuestion = (question: Question) => { if (!requireLogin() || !question.canEdit) { setNotice("当前题库为只读"); return; } const questionModule = modules.find((item) => item.id === question.moduleId); if (questionModule && questionModule.id !== activeModuleId) { setActiveModuleId(questionModule.id); setPaperTitle(`${questionModule.name}专项练习`); setActiveCategory(question.categoryId); } const tagVersions = alevelTagVersions(question); setRecognitionError(""); setOptimizationError(""); setOptimizationPreview(null); setEntryMode(question.originalImage ? "screenshot" : "manual"); setQuestionDraft({ ...question, options: [...question.options], contentImages: [...(question.contentImages ?? [])], ...(isAlevel9709ModuleName(questionModule?.name) ? { tags: tagVersions.zh, tagsZh: tagVersions.zh, tagsEn: tagVersions.en } : {}) }); };

  async function submitAuth() {
    setAuthSubmitting(true); setAuthError("");
    try {
      const result = authMode === "register" ? await register(authEmail, authPassword, authInvite) : await login(authEmail, authPassword);
      setAuthUser(result.user); setAuthDialog(false); setAuthPassword(""); setAuthInvite(""); await refreshLibrary(true, libraryScope);
      setNotice(authMode === "register" ? "注册成功，已登录云端题库" : "登录成功");
    } catch (error) { setAuthError(error instanceof Error ? error.message : "操作失败，请重试"); }
    finally { setAuthSubmitting(false); }
  }

  async function signOut() {
    try { await logout(); setAuthUser(null); setSelectedByScope({ public: [], mine: [] }); setShowSelected(false); setShowWrongBook(false); setStudents([]); setWrongEntries([]); setLibraryScope("public"); await refreshLibrary(false, "public"); setNotice("已退出登录，当前为访客浏览"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "退出失败"); }
  }

  function openFileImport() {
    if (!requireLogin() || !canManageLibrary || !activeModule) return;
    setQuestionDraft(null); setFileImportOpen(true); setFileImportStep("choose"); setFileImportName(""); setFileImportDrafts([]); setFileImportErrors([]);
    setFileImportCategory(activeCategory ?? activeModule.id); setFileImportProgress({ current: 0, total: 0, label: "" });
  }

  function closeFileImport() { fileImportAbortRef.current?.abort(); fileImportAbortRef.current = null; setFileImportOpen(false); }

  async function handleImportDocument(file: File) {
    if (file.size > 80 * 1024 * 1024) { setFileImportErrors(["文件超过 80MB，请拆分后再导入"]); return; }
    const controller = new AbortController(); fileImportAbortRef.current = controller; setFileImportName(file.name); setFileImportDrafts([]); setFileImportErrors([]); setFileImportStep("rendering");
    try {
      const pages = await renderImportFile(file, (current, total) => setFileImportProgress({ current, total, label: `正在读取第 ${current}/${total} 页` }));
      if (controller.signal.aborted) return;
      const structuredQuestions = pages.find((page) => page.sourceQuestions?.length)?.sourceQuestions;
      if (structuredQuestions?.length) {
        setFileImportStep("recognizing"); setFileImportProgress({ current: structuredQuestions.length, total: structuredQuestions.length, label: `已按 Word 原始结构整理 ${structuredQuestions.length} 道题` });
        const sourcePage = pages.find((page) => page.sourceQuestions?.length) ?? pages[0]; const timestamp = currentTimestamp();
        const imported = structuredQuestions.map<FileImportDraft>((item, index) => ({
          id: uid("q"), importId: uid("import"), selected: true, documentNumber: item.questionNumber,
          categoryId: fileImportCategory, type: item.type, difficulty: item.type === "解答题" ? "提高" : "中等",
          stem: item.stem, stemParagraphs: item.stemParagraphs, stemDocxXml: item.stemDocxXml, stemDocxAssets: item.stemDocxAssets,
          options: item.options, optionsDocxXml: item.optionsDocxXml, optionsDocxAssets: item.optionsDocxAssets,
          answer: sourcePage.sourceAnswers?.[item.questionNumber] ?? (item.type === "解答题" ? "见解析" : ""),
          analysis: sourcePage.sourceAnalyses?.[item.questionNumber] ?? "", analysisDocxXml: sourcePage.sourceAnalysisXml?.[item.questionNumber], analysisDocxAssets: sourcePage.sourceAnalysisAssets?.[item.questionNumber],
          provenance: "来源待核实", examYear: "", source: "", tags: [], ...(isAlevel9709ModuleName(activeModule?.name) ? { tagsZh: [], tagsEn: [] } : {}), contentImages: sourcePage.sourceQuestionImages?.[item.questionNumber] ?? [], recognitionConfidence: 1,
          recognitionWarnings: ["题干、配图和解析均从 Word 原始结构读取"], importFileName: file.name, sourcePage: item.sourcePage,
          createdAt: orderedImportTimestamp(timestamp, index), updatedAt: orderedImportTimestamp(timestamp, index),
        }));
        setFileImportDrafts(imported); setFileImportStep("review"); return;
      }
      setFileImportStep("recognizing"); setFileImportProgress({ current: 0, total: pages.length, label: `准备并发识别 ${pages.length} 页` });
      let completed = 0;
      const categoryPayload = moduleCategories.map((item) => ({ id: item.id, path: pathOf(item.id) }));
      const recognizedPages = await mapWithConcurrency(pages, FILE_IMPORT_CONCURRENCY, async (page) => {
        let lastError = "本页识别失败";
        try {
          if (page.documentSection === "answers" && page.sourceAnalyses) return { page, result: { questions: [], answers: [] } as BatchRecognitionResult };
          for (let attempt = 1; attempt <= FILE_IMPORT_MAX_ATTEMPTS; attempt += 1) {
            if (controller.signal.aborted) throw new DOMException("文件录入已取消", "AbortError");
            try {
              const response = await fetch("/api/recognize-batch", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ image: page.image, textHint: page.textHint, pageNumber: page.pageNumber, fileName: file.name, categories: categoryPayload }) });
              const payload = await response.json() as { result?: BatchRecognitionResult; error?: string; code?: string };
              if (response.ok && payload.result) return { page, result: payload.result };
              lastError = payload.code === "MISSING_API_KEY" ? "尚未配置智能识别 API" : payload.error || `识别请求失败（${response.status}）`;
              if (!RETRYABLE_IMPORT_STATUSES.has(response.status) || attempt === FILE_IMPORT_MAX_ATTEMPTS) break;
            } catch (error) {
              if (controller.signal.aborted) throw error;
              lastError = error instanceof Error ? error.message : "识别失败";
              if (attempt === FILE_IMPORT_MAX_ATTEMPTS) break;
            }
            await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
          }
          return { page, error: lastError };
        } finally {
          completed += 1;
          setFileImportProgress({ current: completed, total: pages.length, label: `已识别 ${completed}/${pages.length} 页（同时处理 ${FILE_IMPORT_CONCURRENCY} 页）` });
        }
      });
      if (controller.signal.aborted) return;
      const imported: FileImportDraft[] = []; const pageErrors: string[] = []; const seen = new Set<string>(); const seenNumbers = new Set<string>(); const importStartedAt = currentTimestamp();
      for (const recognized of recognizedPages.sort((a, b) => a.page.pageNumber - b.page.pageNumber)) {
        if ("error" in recognized) { pageErrors.push(`第 ${recognized.page.pageNumber} 页：${recognized.error}`); continue; }
        if (recognized.page.documentSection === "answers") continue;
        for (const item of recognized.result.questions ?? []) {
          const stemKey = item.stem.replace(/\s+/g, "").replace(/[，。；：,.!?！？]/g, "").slice(0, 100); const numberKey = `${item.type}:${item.question_number.trim()}`;
          if (!stemKey || seen.has(stemKey) || (item.question_number.trim() && seenNumbers.has(numberKey))) continue; seen.add(stemKey); if (item.question_number.trim()) seenNumbers.add(numberKey);
          const extracted = await extractRecognizedDiagram(recognized.page.image, item); item.warnings = extracted.warnings;
          let reconstruction: Partial<Question> = extracted.fields;
          if (shouldReconstructRecognizedDiagram(extracted.diagramImage, item.diagram_quality)) {
            setFileImportProgress((current) => ({ ...current, label: `正在为第 ${item.question_number || imported.length + 1} 题高清重绘配图` }));
            try {
              const rebuilt = await requestVectorDiagramReconstruction(item.stem, extracted.diagramImage!, item.diagram_quality);
              if (rebuilt.skipped) item.warnings = [...item.warnings, rebuilt.reason];
              else reconstruction = { diagramOriginalImage: extracted.diagramImage, diagramImage: rebuilt.image, diagramSource: "svg-ai", diagramQuality: item.diagram_quality ?? undefined, vectorDiagramSvg: rebuilt.svg, vectorDiagramPlan: rebuilt.plan, diagramReconstructionConfidence: rebuilt.plan.confidence, diagramVisualFitScore: rebuilt.visualFitScore, diagramReconstructionWarnings: rebuilt.plan.warnings, diagramReconstructedAt: currentTimestamp() };
            } catch (error) { item.warnings = [...item.warnings, `高清矢量重绘未完成：${error instanceof Error ? error.message : "未知错误"}`]; }
          }
          const timestamp = orderedImportTimestamp(importStartedAt, imported.length); const categoryId = item.suggested_category_id && categories.some((entry) => entry.id === item.suggested_category_id) ? item.suggested_category_id : fileImportCategory;
          const normalized = normalizeAnswerFields(item.answer, item.analysis);
          const tagVersions = alevelTagVersions({ tags: item.tags });
          imported.push({ id: uid("q"), importId: uid("import"), selected: true, documentNumber: item.question_number, categoryId, type: item.type, difficulty: item.difficulty, provenance: "来源待核实", examYear: "", stem: item.stem, options: item.options, answer: normalized.answer, analysis: normalized.analysis, source: item.source, tags: isAlevel9709ModuleName(activeModule?.name) ? tagVersions.zh : item.tags, ...(isAlevel9709ModuleName(activeModule?.name) ? { tagsZh: tagVersions.zh, tagsEn: tagVersions.en } : {}), diagramBox: item.diagram_bbox ?? undefined, recognitionConfidence: item.confidence, recognitionWarnings: item.warnings, importFileName: file.name, sourcePage: recognized.page.pageNumber, createdAt: timestamp, updatedAt: timestamp, ...reconstruction });
        }
      }
      for (const recognized of recognizedPages) {
        if ("error" in recognized) continue;
        for (const answerItem of recognized.result.answers ?? []) {
          const target = imported.find((entry) => entry.documentNumber === answerItem.question_number);
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
          const target = imported.find((entry) => entry.documentNumber === questionNumber);
          if (target) target.answer = answer;
        }
      }
      const sourceAnswers = recognizedPages.find((recognized) => !("error" in recognized) && recognized.page.sourceAnswers)?.page.sourceAnswers;
      for (const [questionNumber, answer] of Object.entries(sourceAnswers ?? {})) {
        const target = imported.find((entry) => entry.documentNumber === questionNumber);
        if (target) target.answer = answer;
      }
      const sourceAnalyses = recognizedPages.find((recognized) => !("error" in recognized) && recognized.page.sourceAnalyses)?.page.sourceAnalyses;
      for (const [questionNumber, analysis] of Object.entries(sourceAnalyses ?? {})) {
        const target = imported.find((entry) => entry.documentNumber === questionNumber);
        if (target && analysis.trim()) target.analysis = analysis.trim();
      }
      const sourceAnalysisXml = recognizedPages.find((recognized) => !("error" in recognized) && recognized.page.sourceAnalysisXml)?.page.sourceAnalysisXml;
      for (const [questionNumber, analysisDocxXml] of Object.entries(sourceAnalysisXml ?? {})) {
        const target = imported.find((entry) => entry.documentNumber === questionNumber);
        if (target && analysisDocxXml.length) target.analysisDocxXml = analysisDocxXml;
      }
      const sourceAnalysisAssets = recognizedPages.find((recognized) => !("error" in recognized) && recognized.page.sourceAnalysisAssets)?.page.sourceAnalysisAssets;
      for (const [questionNumber, analysisDocxAssets] of Object.entries(sourceAnalysisAssets ?? {})) {
        const target = imported.find((entry) => entry.documentNumber === questionNumber);
        if (target && Object.keys(analysisDocxAssets).length) target.analysisDocxAssets = analysisDocxAssets;
      }
      const sourceQuestionImages = recognizedPages.find((recognized) => !("error" in recognized) && recognized.page.sourceQuestionImages)?.page.sourceQuestionImages;
      for (const [questionNumber, contentImages] of Object.entries(sourceQuestionImages ?? {})) {
        const target = imported.find((entry) => entry.documentNumber === questionNumber);
        if (target && contentImages.length) { target.contentImages = contentImages; target.diagramImage = undefined; target.diagramBox = undefined; }
      }
      const sourceOptions = recognizedPages.find((recognized) => !("error" in recognized) && recognized.page.sourceOptions)?.page.sourceOptions;
      for (const [questionNumber, options] of Object.entries(sourceOptions ?? {})) {
        const target = imported.find((entry) => entry.documentNumber === questionNumber);
        if (target && options.length >= 2) target.options = options;
      }
      for (const target of imported) {
        if (!isUsableImportedAnswer(target.answer)) target.answer = explicitChoiceFromAnalysis(target.analysis);
      }
      setFileImportDrafts(imported); setFileImportErrors(pageErrors); setFileImportStep("review");
    } catch (error) { if (!controller.signal.aborted) { setFileImportErrors([error instanceof Error ? error.message : "无法读取这个文件"]); setFileImportStep("choose"); } }
    finally { if (fileImportAbortRef.current === controller) fileImportAbortRef.current = null; }
  }

  function updateImportDraft(importId: string, changes: Partial<FileImportDraft>) {
    setFileImportDrafts((current) => current.map((item) => item.importId === importId ? {
      ...item,
      ...changes,
      ...(changes.stem === undefined ? {} : { stemDocxXml: undefined, stemDocxAssets: undefined }),
      ...(changes.options === undefined ? {} : { optionsDocxXml: undefined, optionsDocxAssets: undefined }),
      ...(changes.analysis === undefined ? {} : { analysisDocxXml: undefined, analysisDocxAssets: undefined }),
    } : item));
  }

  async function saveImportedQuestions() {
    const selected = fileImportDrafts.filter((item) => item.selected && item.stem.trim() && item.categoryId);
    if (!selected.length) { setNotice("请至少选择一道题，并确认题干和分类"); return; }
    const isAlevelImport = isAlevel9709ModuleName(activeModule?.name);
    if (isAlevelImport) {
      const incompleteIndex = selected.findIndex((item) => { const versions = alevelTagVersions(item); return versions.zh.length !== versions.en.length; });
      if (incompleteIndex >= 0) { setNotice(`第 ${incompleteIndex + 1} 道已选题目的中英文知识点数量不一致，请按顺序配对`); return; }
    }
    const saved: Question[] = selected.map((item) => {
      const question = { ...item } as Partial<FileImportDraft>;
      delete question.importId; delete question.selected; delete question.documentNumber;
      const tagVersions = alevelTagVersions(item);
      return { ...question, moduleId: activeModule?.id, stem: item.stem.trim(), stemParagraphs: item.stem.split(/\r?\n/).filter((line) => line.length > 0), options: item.options.map((option) => option.trim()).filter(Boolean), ...(isAlevelImport ? { tags: tagVersions.zh, tagsZh: tagVersions.zh, tagsEn: tagVersions.en } : {}), updatedAt: currentTimestamp() } as Question;
    });
    try {
      const uploaded = await Promise.all(saved.map(async (question) => (await createCloudQuestion(question, libraryScope)).question));
      setQuestions((current) => [...uploaded, ...current].sort((a, b) => b.createdAt - a.createdAt)); setFileImportOpen(false); setNotice(`已从文件录入 ${uploaded.length} 道云端试题`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "文件题目保存失败"); }
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
      const uploadImage = await materializeImageDataUrl(image);
      const response = await fetch("/api/recognize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: uploadImage, categories: moduleCategories.map((item) => ({ id: item.id, path: pathOf(item.id) })) }) });
      const payload = await response.json() as { result?: RecognitionQuestionResult; error?: string; code?: string };
      if (!response.ok || !payload.result) throw new Error(payload.code === "MISSING_API_KEY" ? "智能识别尚未配置。请检查本地 Sub2API 地址、Key 和视觉模型。" : payload.error || "识别失败，请重试");
      const result = payload.result;
      const extracted = await extractRecognizedDiagram(image, result);
      let reconstruction: Partial<Question> = extracted.fields;
      const warnings = extracted.warnings;
      const recognitionDurationMs = Math.round(monotonicTime() - recognitionStartedAt);
      const tagVersions = alevelTagVersions({ tags: result.tags });
      const baseDraft: Partial<Question> = { type: result.type, difficulty: result.difficulty, stem: result.stem, options: result.options.length ? result.options : [], answer: cleanRecognizedAnswer(result.answer), analysis: cleanRecognizedAnalysis(result.analysis), source: result.source, tags: questionDraftIsAlevel ? tagVersions.zh : result.tags, ...(questionDraftIsAlevel ? { tagsZh: tagVersions.zh, tagsEn: tagVersions.en } : {}), categoryId: result.suggested_category_id && categories.some((item) => item.id === result.suggested_category_id) ? result.suggested_category_id : questionDraft.categoryId, originalImage: image, diagramBox: result.diagram_bbox ?? undefined, recognitionConfidence: result.confidence, recognitionWarnings: warnings, recognitionDurationMs, ...reconstruction };
      setQuestionDraft((current) => current ? { ...current, ...baseDraft } : current);
      setIsRecognizing(false);
      if (shouldReconstructRecognizedDiagram(extracted.diagramImage, result.diagram_quality, enableVectorReconstruction)) {
        setIsReconstructingDiagram(true);
        setNotice(`文字识别已完成（${(recognitionDurationMs / 1000).toFixed(1)} 秒），正在后台高清重绘配图`);
        const reconstructionStartedAt = monotonicTime();
        try {
          const rebuilt = await requestVectorDiagramReconstruction(result.stem, extracted.diagramImage!, result.diagram_quality);
          if (rebuilt.skipped) warnings.push(rebuilt.reason);
          else reconstruction = { diagramOriginalImage: extracted.diagramImage, diagramImage: rebuilt.image, diagramSource: "svg-ai", vectorDiagramSvg: rebuilt.svg, vectorDiagramPlan: rebuilt.plan, diagramReconstructionConfidence: rebuilt.plan.confidence, diagramVisualFitScore: rebuilt.visualFitScore, diagramReconstructionWarnings: rebuilt.plan.warnings, diagramReconstructedAt: currentTimestamp(), diagramReconstructionDurationMs: Math.round(monotonicTime() - reconstructionStartedAt) };
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
    if (!file.type.startsWith("image/")) { setRecognitionError("请选择图片文件"); return; }
    if (file.size > 15 * 1024 * 1024) { setRecognitionError("图片超过 15MB，请先裁剪或压缩"); return; }
    try { const image = await compressDataUrl(await fileToDataUrl(file), 3200); setQuestionDraft((current) => current ? { ...current, originalImage: image, diagramImage: undefined, diagramOriginalImage: undefined, diagramSource: undefined, diagramQuality: undefined, diagramBox: undefined, geogebraBase64: undefined, geogebraPlan: undefined, vectorDiagramSvg: undefined, vectorDiagramPlan: undefined, diagramReconstructionConfidence: undefined, diagramVisualFitScore: undefined, diagramReconstructionWarnings: undefined, diagramReconstructedAt: undefined } : current); await recognizeImage(image); }
    catch { setRecognitionError("无法读取这张图片，请换一张重试"); }
  }

  async function handleManualImages(files: File[]) {
    const available = Math.max(0, 4 - (questionDraft?.contentImages?.length ?? 0));
    if (!available) { setNotice("每道题最多添加 4 张配图"); return; }
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
    if (!questionDraft?.originalImage || !cropSelection || cropSelection.width < 10 || cropSelection.height < 10) { setNotice("请先框选完整配图"); return; }
    const diagramImage = await cropExactDataUrl(questionDraft.originalImage, cropSelection); setQuestionDraft({ ...questionDraft, diagramImage, diagramOriginalImage: undefined, diagramSource: "extracted", diagramBox: cropSelection, geogebraBase64: undefined, geogebraPlan: undefined, vectorDiagramSvg: undefined, vectorDiagramPlan: undefined, diagramReconstructionConfidence: undefined, diagramVisualFitScore: undefined, diagramReconstructionWarnings: undefined, diagramReconstructedAt: undefined }); setCropDialog(false); setNotice("配图已重新裁剪");
  }

  async function persistQuestion() {
    if (!questionDraft || !questionDraft.stem.trim() || !questionDraft.categoryId) { setNotice("请填写题干并选择分类"); return; }
    const tagVersions = alevelTagVersions(questionDraft);
    if (questionDraftIsAlevel && tagVersions.zh.length !== tagVersions.en.length) { setNotice("请让中文和 English 知识点一一对应；不填写时两边都留空"); return; }
    const timestamp = currentTimestamp();
    const saved: Question = { ...questionDraft, id: questionDraft.id || uid("q"), moduleId: questionDraft.moduleId || activeModule?.id, provenance: normalizeQuestionProvenance(questionDraft.provenance), examYear: questionDraft.examYear?.trim(), stem: questionDraft.stem.trim(), options: questionDraft.options.map((item) => item.trim()).filter(Boolean), ...(questionDraftIsAlevel ? { tags: tagVersions.zh, tagsZh: tagVersions.zh, tagsEn: tagVersions.en } : {}), createdAt: questionDraft.createdAt || timestamp, updatedAt: timestamp };
    try {
      const result = questionDraft.id ? await updateCloudQuestion(saved, libraryScope) : await createCloudQuestion(saved, libraryScope);
      setQuestions((current) => [result.question, ...current.filter((item) => item.id !== result.question.id)].sort((a, b) => b.createdAt - a.createdAt));
      setQuestionDraft(null); setNotice(questionDraft.id ? "云端试题已更新" : "试题已保存到云端");
    } catch (error) { setNotice(error instanceof Error ? error.message : "试题保存失败"); }
  }

  async function deleteQuestion(question: Question) {
    if (!window.confirm("确定删除这道试题吗？此操作无法撤销。")) return;
    try { await deleteCloudQuestion(question.id, libraryScope); setQuestions((current) => current.filter((item) => item.id !== question.id)); setSelectedIds((current) => current.filter((id) => id !== question.id)); setNotice("试题已删除"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "删除失败"); }
  }

  async function deleteSelectedQuestions() {
    const ids = selectedIds.filter((id) => questions.some((item) => item.id === id));
    if (!ids.length) { setBatchDeleteOpen(false); return; }
    const editableIds = ids.filter((id) => questions.find((item) => item.id === id)?.canEdit);
    if (!editableIds.length) { setBatchDeleteOpen(false); setNotice("所选题目中没有你可以删除的内容"); return; }
    try {
      await Promise.all(editableIds.map((id) => deleteCloudQuestion(id, libraryScope)));
      setQuestions((current) => current.filter((item) => !editableIds.includes(item.id)));
      setExpandedAnswers((current) => current.filter((id) => !editableIds.includes(id)));
      setSelectedIds((current) => current.filter((id) => !editableIds.includes(id))); setBatchDeleteOpen(false); setNotice(`已删除 ${editableIds.length} 道有权限的试题`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "批量删除失败"); }
  }

  async function createCategory() {
    if (!categoryName.trim() || !activeModule) { setNotice("请填写分类名称"); return; }
    const category: Category = { id: uid("cat"), name: categoryName.trim(), moduleId: activeModule.id, parentId: categoryParent || activeModule.id, createdAt: currentTimestamp() };
    try { const result = await createCloudCategory(category, libraryScope); setCategories((current) => [...current, result.category]); setCategoryName(""); setCategoryDialog(null); setActiveCategory(result.category.id); setNotice("分类已创建"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "分类创建失败"); }
  }

  async function deleteCategory(category: Category) {
    const categoryIds = descendantsOf(category.id); const questionIds = questions.filter((item) => categoryIds.includes(item.categoryId)).map((item) => item.id);
    if (!window.confirm(`删除“${category.name}”会同时删除其子分类和 ${questionIds.length} 道试题。确定继续吗？`)) return;
    try { await deleteCloudCategory(category.id, libraryScope); setCategories((current) => current.filter((item) => !categoryIds.includes(item.id))); setQuestions((current) => current.filter((item) => !questionIds.includes(item.id))); setSelectedIds((current) => current.filter((id) => !questionIds.includes(id))); setActiveCategory(activeModule?.id ?? null); setNotice("分类已删除"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "分类删除失败"); }
  }

  function exportBackup() {
    const data: LibraryData = { scope: libraryScope, modules, categories, questions, publishedAt };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `Mitty${libraryScope === "public" ? "公共" : "私人"}题库备份-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice("备份文件已导出");
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    try { const data = JSON.parse(await file.text()) as LibraryData; if (!Array.isArray(data.categories) || !Array.isArray(data.questions)) throw new Error("bad shape"); if (!window.confirm("导入后会把备份中的模块、分类和题目追加到当前题库，是否继续？")) return; const result = await importCloudLibrary(data, libraryScope); await refreshLibrary(false); setSelectedIds([]); setCategoryDialog(null); setNotice(`已迁移 ${result.imported} 道题到当前题库`); } catch (error) { setNotice(error instanceof Error ? error.message : "无法识别这个备份文件"); } finally { event.target.value = ""; }
  }

  async function generateWord() {
    if (!selectedQuestions.length || isExporting) return;
    setIsExporting(true);
    try { await authorizeDownload(libraryScope, selectedQuestions.map((question) => question.id)); await exportQuestionsToWord(selectedQuestions, paperTitle.trim() || "练习题", includeAnswers, "basket"); setExportDialog(false); setNotice("Word 练习已生成"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "下载失败"); }
    finally { setIsExporting(false); }
  }

  function openNewModule() {
    if (!requireLogin() || !canManageLibrary) return;
    setModuleDraft(null); setModuleName(""); setModuleSubtitle(""); setModuleDialog("new");
  }

  function openModuleEditor(module: LibraryModule) {
    setModuleDraft(module); setModuleName(module.name); setModuleSubtitle(module.subtitle); setModuleDialog("new");
  }

  async function saveModule() {
    if (!moduleName.trim()) { setNotice("请填写模块名称"); return; }
    try {
      if (moduleDraft) {
        const result = await updateCloudModule({ ...moduleDraft, name: moduleName.trim(), subtitle: moduleSubtitle.trim() }, libraryScope);
        setModules((current) => current.map((item) => item.id === result.module.id ? result.module : item));
        if (activeModuleId === result.module.id) setPaperTitle(`${result.module.name}专项练习`);
        setNotice("模块已更新");
      } else {
        const result = await createCloudModule({ name: moduleName.trim(), subtitle: moduleSubtitle.trim() }, libraryScope);
        setModules((current) => [...current, result.module]); setActiveModuleId(result.module.id); setActiveCategory(result.module.id); setPaperTitle(`${result.module.name}专项练习`);
        setNotice("模块已创建");
      }
      setModuleDialog(null); setModuleDraft(null); setModuleName(""); setModuleSubtitle("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "模块保存失败"); }
  }

  async function moveModule(id: string, direction: -1 | 1) {
    const index = modules.findIndex((item) => item.id === id); const target = index + direction;
    if (index < 0 || target < 0 || target >= modules.length) return;
    const next = [...modules]; [next[index], next[target]] = [next[target], next[index]];
    const ordered = next.map((item, sortOrder) => ({ ...item, sortOrder }));
    setModules(ordered);
    try { await reorderCloudModules(ordered.map((item) => item.id), libraryScope); }
    catch (error) { await refreshLibrary(true); setNotice(error instanceof Error ? error.message : "模块排序失败"); }
  }

  async function dropModule(targetId: string) {
    if (!draggedModuleId || draggedModuleId === targetId) { setDraggedModuleId(""); return; }
    const source = modules.find((item) => item.id === draggedModuleId); const targetIndex = modules.findIndex((item) => item.id === targetId);
    if (!source || targetIndex < 0) return;
    const next = modules.filter((item) => item.id !== draggedModuleId); next.splice(targetIndex, 0, source);
    const ordered = next.map((item, sortOrder) => ({ ...item, sortOrder })); setModules(ordered); setDraggedModuleId("");
    try { await reorderCloudModules(ordered.map((item) => item.id), libraryScope); }
    catch (error) { await refreshLibrary(true); setNotice(error instanceof Error ? error.message : "模块排序失败"); }
  }

  async function confirmDeleteModule() {
    if (!deleteModuleTarget) return;
    try {
      await deleteCloudModule(deleteModuleTarget.id, deleteModuleConfirmation, libraryScope);
      const removedId = deleteModuleTarget.id;
      const next = modules.filter((item) => item.id !== removedId);
      const removedQuestions = questions.filter((item) => item.moduleId === removedId).map((item) => item.id);
      setModules(next); setCategories((current) => current.filter((item) => item.moduleId !== removedId)); setQuestions((current) => current.filter((item) => item.moduleId !== removedId));
      setSelectedIds((current) => current.filter((id) => !removedQuestions.includes(id)));
      setDeleteModuleTarget(null); setDeleteModuleConfirmation(""); setModuleDialog(null);
      setActiveModuleId(next[0]?.id ?? ""); setActiveCategory(next[0]?.id ?? null); if (next[0]) setPaperTitle(`${next[0].name}专项练习`);
      setNotice("模块及其内容已删除");
    } catch (error) { setNotice(error instanceof Error ? error.message : "模块删除失败"); }
  }

  async function openCopyDialog() {
    if (!requireLogin() || libraryScope !== "public" || !selectedIds.length) return;
    try {
      const data = await fetchLibrary("mine"); setCopyTargetData(data);
      const first = data.modules[0]; setCopyTargetModule(first?.id ?? ""); setCopyTargetCategory(first?.id ?? ""); setCopyDialog(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法读取私人题库"); }
  }

  async function confirmCopyQuestions() {
    if (!copyTargetModule) { setNotice("请先在私人题库创建模块"); return; }
    try {
      const result = await copyPublicQuestions(selectedIds, copyTargetModule, copyTargetCategory || copyTargetModule);
      setCopyDialog(false); setNotice(`已复制 ${result.copied} 道题到私人题库`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "复制题目失败"); }
  }

  async function publishLibrary() {
    if (!authUser?.local || libraryScope !== "public") return;
    if (!window.confirm("将当前公共编辑库完整发布到线上，线上多余内容也会删除。确定继续吗？")) return;
    setIsPublishing(true); setPublicationFailed(false); setPublicationProgress({ phase: "snapshot", current: 0, total: 1, label: "正在准备发布快照" }); setNotice("正在比对差异并上传变更资源…");
    try {
      const result = await publishPublicLibrary(setPublicationProgress); setPublishedAt(result.publishedAt);
      const changed = result.diff.modules.added + result.diff.modules.updated + result.diff.modules.deleted
        + result.diff.categories.added + result.diff.categories.updated + result.diff.categories.deleted
        + result.diff.questions.added + result.diff.questions.updated + result.diff.questions.deleted;
      setNotice(`发布完成：${changed} 项内容变更，${result.diff.missingAssets} 个新资源${result.knowledgeGraph?.changed ? `；知识图谱已同步为线上 v${result.knowledgeGraph.version}` : ""}`);
    } catch (error) { setPublicationFailed(true); setNotice(error instanceof Error ? error.message : "公共资源库发布失败"); }
    finally { setIsPublishing(false); }
  }

  function renderTree(parentId: string | null, depth = 0) {
    return childrenOf(parentId).map((category) => (
      <div key={category.id}>
        <button className={`tree-row ${activeCategory === category.id && !showSelected ? "active-leaf" : ""}`} style={{ paddingLeft: 10 + depth * 17 }} onClick={() => { setActiveCategory(category.id); setShowSelected(false); }}>
          <span className="tree-dot">{childrenOf(category.id).length ? "◆" : "·"}</span><span className="tree-name">{category.name}</span><span className="count">{countFor(category.id)}</span>
        </button>
        {renderTree(category.id, depth + 1)}
      </div>
    ));
  }

  function renderModuleTree() {
    if (!activeModule) return <p className="empty-tree">请先创建一个模块</p>;
    return <>
      <button className={`tree-row module-root ${activeCategory === activeModule.id && !showSelected ? "active-leaf" : ""}`} onClick={() => { setActiveCategory(activeModule.id); setShowSelected(false); }}>
        <span className="tree-dot">◆</span><span className="tree-name">{activeModule.name}</span><span className="count">{countFor(activeModule.id)}</span>
      </button>
      {renderTree(activeModule.id, 1)}
    </>;
  }

  return (
    <main className={`app-shell ${isAlevelPage ? `alevel-page locale-${pageLocale}` : ""}`.trim()}>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">题</span><div><strong>Mitty</strong><span>{pageCopy.brandSubtitle}</span></div></div>
        <nav className="library-entries" aria-label="题库入口"><button className={`nav-item ${libraryScope === "public" && !showSelected && !showWrongBook ? "active" : ""}`} onClick={() => switchLibraryScope("public")}>{pageCopy.navPublic}</button><button className={`nav-item ${showWrongBook ? "active" : ""}`} onClick={openWrongBook}>{pageCopy.navStudents}</button>{authUser && <><button className={`nav-item ${showSelected && !showWrongBook ? "active" : ""}`} onClick={() => { setShowWrongBook(false); setShowSelected(true); }}>{pageCopy.navBasket}{selectedIds.length ? <i>{selectedIds.length}</i> : null}</button><a className="nav-item" href="/knowledge-graph">{pageCopy.navKnowledge}</a><a className="nav-item" href="/tools">{pageCopy.navTools}</a></>}</nav>
        <div className="account-area"><div className="theme-switch" role="group" aria-label={pageCopy.displayMode}><button className={colorTheme === "light" ? "active" : ""} aria-label={pageCopy.light} aria-pressed={colorTheme === "light"} onClick={() => chooseColorTheme("light")}><span aria-hidden="true">☀</span><b>{pageCopy.light}</b></button><button className={colorTheme === "dark" ? "active" : ""} aria-label={pageCopy.dark} aria-pressed={colorTheme === "dark"} onClick={() => chooseColorTheme("dark")}><span aria-hidden="true">☾</span><b>{pageCopy.dark}</b></button></div>{authLoading ? <span className="guest-badge">{pageCopy.connecting}</span> : authUser ? <><span className="user-chip"><b>{authUser.local ? pageCopy.localAdmin : authUser.role === "admin" ? pageCopy.admin : pageCopy.member}</b>{authUser.local ? pageCopy.noLogin : authUser.email}</span>{!authUser.local && <button className="account-button" onClick={signOut}>{pageCopy.signOut}</button>}{canManageLibrary && !showWrongBook && !showSelected && <button className="primary-button" onClick={openNewQuestion} disabled={!activeModule}><span>＋</span> {pageCopy.newQuestion}</button>}</> : <><span className="guest-badge">{pageCopy.guestBrowse}</span><button className="account-button" onClick={() => { setAuthMode("login"); setAuthError(""); setAuthDialog(true); }}>{pageCopy.loginRegister}</button></>}</div>
      </header>

      <section className={`workspace ${showSelected && !showWrongBook ? "basket-workspace" : ""}`}>
        {(!showSelected || showWrongBook) && <aside className="sidebar">
          {showWrongBook ? <>
            <div className="sidebar-heading"><div><span className="eyebrow">学生专属空间</span><h2>学生档案</h2></div><button className="icon-button" aria-label="新建学生" title="新建学生" onClick={() => openStudentDialog()}>＋</button></div>
            <div className="student-list">{students.length ? students.map((student) => <button key={student.id} className={`student-card ${student.id === activeStudentId ? "active" : ""}`} onClick={() => selectStudent(student.id)}><span>{student.name.slice(0, 1)}</span><div><b>{student.name}</b><small>{student.className || "未填写班级"}</small></div><em>{student.wrongCount}</em></button>) : <div className="student-list-empty"><span>人</span><b>还没有学生档案</b><p>先创建学生，再上传他的已完成作业。</p></div>}</div>
            <button className="manage-button" onClick={() => openStudentDialog()}>＋ 新建学生档案</button>
            {activeStudent && <div className="student-profile-actions"><button onClick={() => openStudentDialog(activeStudent)}>编辑档案</button><button className="danger-text" onClick={() => removeStudent(activeStudent)}>删除</button></div>}
          </> : <>
          <div className="sidebar-heading"><div><span className="eyebrow">{activeModule?.name ?? (libraryScope === "public" ? pageCopy.publicLibrary : pageCopy.myLibrary)}</span><h2>{pageCopy.knowledgeDirectory}</h2></div>{canManageLibrary && activeModule && <button className="icon-button" aria-label={pageCopy.addCategory} title={pageCopy.addCategory} onClick={() => { setCategoryParent(activeCategory ?? activeModule.id); setCategoryDialog("new"); }}>＋</button>}</div>
          <div className="tree">{renderModuleTree()}</div>
          {canManageLibrary ? <button className="manage-button" onClick={() => setCategoryDialog("manage")} disabled={!activeModule}>{pageCopy.manageCategories}</button> : !authUser ? <button className="manage-button" onClick={() => { setAuthMode("login"); setAuthDialog(true); }}>{pageCopy.loginToDownload}</button> : <span className="sidebar-readonly">{pageCopy.maintainedByAdmin}</span>}
          </>}
        </aside>}

        <section className="content">
          {showWrongBook ? <>
            <div className="student-archive-heading"><h1>学生档案</h1><StudentArchiveTabs active="wrong-book" /></div>
            <div className="library-context-bar wrong-book-context"><div><b>学生专属错题本</b><span>不同学生的错题、次数和复习状态彼此独立</span></div><small>{students.length} 位学生 · {students.reduce((total, student) => total + student.wrongCount, 0)} 道错题记录</small><button className="secondary" onClick={() => openStudentDialog()}>新建学生</button></div>
            {!!students.length && <label className="mobile-student-picker"><span>当前学生</span><select value={activeStudentId} onChange={(event) => selectStudent(event.target.value)}>{students.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.wrongCount} 道错题</option>)}</select></label>}
            {activeStudent ? <>
              <div className="wrong-book-hero"><div className="student-avatar">{activeStudent.name.slice(0, 1)}</div><div><p className="breadcrumb">{activeStudent.className || "未填写班级"}</p><h1>{activeStudent.name}的错题本</h1><p className="subtext">{activeStudent.notes || "记录易错点，复习后可标记为已掌握"}</p></div><div className="wrong-book-stats"><span><b>{activeStudent.wrongCount}</b>全部错题</span><span><b>{activeStudent.reviewingCount}</b>复习中</span><span><b>{activeStudent.masteredCount}</b>已掌握</span></div></div>
              <div className="content-head wrong-book-head"><div><p className="breadcrumb">学习记录</p><h2>{activeWrongEntries.length ? "作业错题清单" : "开始建立错题本"}</h2><p className="subtext">错题来自学生作业自动批改，仅记录完全错误的题目。</p>{!!activeWrongEntries.length && <a className="wrong-upload-link" href={`/homework/upload?studentId=${encodeURIComponent(activeStudent.id)}`}>上传作业并批改</a>}</div><label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索学生错题" placeholder="搜索题干、来源或备注…" /></label></div>
              <div className="question-list wrong-question-list">
                {wrongBookLoading ? <div className="wrong-book-loading"><i></i><span>正在读取错题记录…</span></div> : !filteredWrongEntries.length ? <div className="empty-state"><div>错</div><h3>{activeWrongEntries.length ? "没有符合搜索的错题" : "还没有错题记录"}</h3><p>{activeWrongEntries.length ? "换一个关键词继续查找" : "上传学生作业，批改后自动建立错题记录"}</p><a className="wrong-upload-link" href={`/homework/upload?studentId=${encodeURIComponent(activeStudent.id)}`}>上传作业并批改</a></div> : filteredWrongEntries.map((entry, index) => {
                  const question = entry.question; const answerKey = `wrong-${entry.id}`; const answerOpen = expandedAnswers.includes(answerKey); const images = questionImages(question); const imageLayout = resolveQuestionImageLayout(question); const compactConclusion = isCompactConclusionQuestion(question);
                  return <article className={`question-card wrong-question-card ${entry.mastered ? "mastered" : ""}`} key={entry.id}>
                    <div className={`wrong-status ${entry.mastered ? "mastered" : "reviewing"}`}>{entry.mastered ? "已掌握" : "复习中"}</div>
                    <div className="question-main">
                      <div className="meta"><span>{question.type}</span><span className={question.difficulty === "提高" ? "hard" : question.difficulty === "中等" ? "medium" : "easy"}>{question.difficulty}</span><span className="wrong-count-badge">错 {entry.mistakeCount} 次</span><em>{entry.sourcePath}</em></div>
                      <div className={`question-presentation ${images.length ? `with-images layout-${imageLayout}${compactConclusion ? " compact-conclusion" : ""}` : ""}`}>
                        <div className="question-copy"><div className="stem"><b className="question-number">{index + 1}.</b><div className="stem-body">{question.source && <span className="question-source">（{question.source}）</span>}<DocxContent xml={question.stemDocxXml} fallback={question.stem} stripLeadingQuestionNumber /></div></div>{!!question.options.length && !compactConclusion && <DocxOptions xml={question.optionsDocxXml} fallback={question.options} />}</div>
                        {!!images.length && <div className={`question-images ${images.length > 1 ? "multiple" : ""}`}>{images.map((image, imageIndex) =>
                          // eslint-disable-next-line @next/next/no-img-element
                          <img className="question-diagram" src={image} alt={`错题配图 ${imageIndex + 1}`} key={`${entry.id}-image-${imageIndex}`} />
                        )}</div>}
                        {!!question.options.length && compactConclusion && <DocxOptions xml={question.optionsDocxXml} fallback={question.options} />}
                      </div>
                      {entry.note && <div className="wrong-note"><b>学生错因 / 复习备注</b><p>{entry.note}</p></div>}
                      <WrongQuestionEvidence entry={entry} />
                      {answerOpen && <div className="answer-box"><b>答案</b><p><MathText text={question.answer || "略"} /></p>{question.analysis && <><b>解析</b><div className="analysis-content">{question.studioSource ? <StudioSolution source={{...question.studioSource,analysis:question.analysis}}/> : <DocxContent xml={question.analysisDocxXml} fallback={question.analysis} />}</div></>}</div>}
                      <div className="question-actions"><button onClick={() => setExpandedAnswers((current) => current.includes(answerKey) ? current.filter((id) => id !== answerKey) : [...current, answerKey])}>{answerOpen ? "收起解析" : "查看解析"}</button><small>最近记录 {new Date(entry.lastWrongAt).toLocaleDateString("zh-CN")}</small><span></span><button onClick={() => setWrongEntryDraft(entry)}>编辑记录</button><button onClick={() => toggleWrongMastery(entry)}>{entry.mastered ? "继续复习" : "标为掌握"}</button>{entry.submissionId ? <a href={`/homework/submissions/${entry.submissionId}`}>修正批改</a> : null}</div>
                    </div>
                  </article>;
                })}
              </div>
              {!!historicalWrongEntries.length && <details className="wrong-history"><summary>历史记录（{historicalWrongEntries.length}）</summary><p>旧手动记录、部分正确及已修正的记录保留在此，不计入当前错题统计。</p>{historicalWrongEntries.map(entry => <article key={entry.id}><b>{entry.sourcePath}</b><p><MathText text={entry.question.stem} /></p><small>{entry.archiveReason}</small><WrongQuestionEvidence entry={entry} /></article>)}</details>}
            </> : <div className="empty-state wrong-book-empty"><div>人</div><h3>{wrongBookLoading ? "正在读取学生档案" : "为第一位学生建立错题本"}</h3><p>每位学生都有独立的错题、错误次数、复习备注和掌握状态。</p><button onClick={() => openStudentDialog()}>＋ 新建学生档案</button></div>}
          </> : <>
          {showSelected ? <>
            <div className="basket-heading">
              <div><p className="breadcrumb">选题完成后，在这里整理练习</p><h1>组卷篮 <span>{selectedQuestions.length} 题</span></h1><p className="subtext">题目按下方顺序生成 Word，可随时继续选题。</p></div>
              {!!selectedQuestions.length && <button className="secondary" onClick={() => setShowSelected(false)}>继续选题</button>}
            </div>
            {!!selectedQuestions.length && <>
              <div className="basket-settings">
                <label className="basket-title">练习标题<input value={paperTitle} disabled={isExporting} onChange={(event) => setPaperTitle(event.target.value)} placeholder="输入练习标题" /></label>
                <label className="basket-answer" htmlFor="basket-include-answers" aria-label="附带答案与解析"><input id="basket-include-answers" type="checkbox" checked={includeAnswers} disabled={isExporting} onChange={(event) => setIncludeAnswers(event.target.checked)} /><span><b>附带答案与解析</b><small>在练习题末尾另起一页</small></span></label>
              </div>
              <div className="basket-toolbar"><span>已选 {selectedQuestions.length} 题 · 上移或下移调整顺序</span><PaperMoreMenu>{libraryScope === "public" && <button disabled={isExporting} onClick={openCopyDialog}>复制到私人题库</button>}<button disabled={isExporting} onClick={() => setSelectedIds([])}>清空组卷篮</button></PaperMoreMenu><button className="primary-button" disabled={isExporting} onClick={generateWord}>{isExporting ? "正在生成…" : "生成 Word"}</button></div>
            </>}
          </> : <>
          <div className="library-context-bar"><div><b>{libraryScope === "public" ? pageCopy.publicLibrary : pageCopy.myLibrary}</b><span>{libraryScope === "public" ? authUser ? pageCopy.publicMemberAccess : pageCopy.publicGuestAccess : pageCopy.privateAccess}</span>{authUser?.local && libraryScope === "public" && publicationProgress && <span className={`publication-progress ${publicationFailed ? "failed" : ""}`}><i><em style={{ width: `${publicationProgress.total ? Math.max(publicationProgress.phase === "complete" ? 100 : 8, publicationProgress.current / publicationProgress.total * 100) : 8}%` }} /></i>{publicationFailed ? `${pageCopy.publishFailed} · ${publicationProgress.label}` : publicationProgress.label}</span>}</div>{libraryScope === "public" && publishedAt && <small>{pageCopy.recentlyPublished} {new Date(publishedAt).toLocaleString(pageLocale === "en" ? "en-GB" : "zh-CN")}</small>}{authUser?.local && libraryScope === "public" && <button className="secondary" disabled={isPublishing} onClick={publishLibrary}>{isPublishing ? pageCopy.publishing : publicationFailed ? pageCopy.retryPublish : pageCopy.publishLibrary}</button>}{canManageLibrary && <button className="secondary" onClick={() => setModuleDialog("manage")}>{pageCopy.manageModules}</button>}</div>
          <div className="module-switcher" aria-label={pageCopy.moduleSwitcher}>
            {modules.map((examModule, index) => <button key={examModule.id} className={activeModule?.id === examModule.id && !showSelected ? "active" : ""} onClick={() => switchExamModule(examModule.id)}>
              <span>{String(index + 1).padStart(2, "0")}</span><div><b>{examModule.name}</b><small>{examModule.subtitle || pageCopy.noSubtitle}</small></div><em>{pageLocale === "en" ? alevelQuestionCount(countFor(examModule.id), pageLocale) : `${countFor(examModule.id)} ${pageCopy.questionUnit}`}</em>
            </button>)}
            {canManageLibrary && <button className="module-add" onClick={openNewModule}><span>＋</span><div><b>{pageCopy.newModule}</b><small>{pageCopy.customModule}</small></div></button>}
          </div>
          <div className="content-head">
            <div><p className="breadcrumb">{showSelected ? "当前题库组卷篮" : activeCategory ? pathOf(activeCategory) : activeModule?.name ?? "尚无模块"}</p><h1>{activeName}</h1><p className="subtext">{alevelQuestionCount(filteredQuestions.length, pageLocale)} · {showSelected ? "可跨当前题库的模块组卷" : activeModule ? `${activeModule.name} ${pageCopy.moduleSuffix}` : "创建第一个模块后开始录题"}{authUser ? authUser.local ? ` · ${pageCopy.localAdminSuffix}` : ` · ${pageCopy.loggedInAs} ${authUser.role === "admin" ? pageCopy.admin : pageCopy.member}` : ` · ${pageCopy.guestSuffix}`}</p></div>
            <div className="content-head-actions">{isAlevelPage && <div className="page-language-switch" role="group" aria-label={pageCopy.language}><button lang="zh-CN" className={alevelPageLocale === "zh" ? "active" : ""} aria-pressed={alevelPageLocale === "zh"} onClick={() => chooseAlevelPageLocale("zh")}>中文</button><button lang="en" className={alevelPageLocale === "en" ? "active" : ""} aria-pressed={alevelPageLocale === "en"} onClick={() => chooseAlevelPageLocale("en")}>English</button></div>}<label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={pageCopy.searchLabel} placeholder={pageCopy.searchPlaceholder} /></label></div>
          </div>
          <div className="provenance-filters" aria-label={pageCopy.propertyFilter}>
            <span>{pageCopy.property}</span>
            <button className={provenanceFilter === "全部" ? "active" : ""} onClick={() => setProvenanceFilter("全部")}>{pageCopy.all} <b>{showSelected ? selectedQuestions.length : categoryQuestions.length}</b></button>
            {QUESTION_PROVENANCES.map((provenance) => <button key={provenance} className={provenanceFilter === provenance ? "active" : ""} onClick={() => setProvenanceFilter(provenance as QuestionProvenance)}>{alevelPageLabel(provenance, pageLocale)} <b>{(showSelected ? selectedQuestions : categoryQuestions).filter((item) => normalizeQuestionProvenance(item.provenance) === provenance).length}</b></button>)}
          </div>
          <div className="filters">
            <button className={`filter ${typeFilter === "全部" ? "active" : ""}`} onClick={() => setTypeFilter("全部")}>{pageCopy.allTypes} <span>{showSelected ? selectedQuestions.length : categoryQuestions.length}</span></button>
            {questionTypes.map((type) => <button key={type} className={`filter ${typeFilter === type ? "active" : ""}`} onClick={() => setTypeFilter(type)}>{pageLocale === "en" ? alevelPageLabel(type, pageLocale) : type.replace("单选题", "选择题")} <span>{(showSelected ? selectedQuestions : categoryQuestions).filter((item) => item.type === type).length}</span></button>)}
            {authUser && <button className={`select-visible ${allFilteredSelected ? "active" : ""}`} disabled={!filteredQuestions.length} onClick={toggleAllFiltered}>{allFilteredSelected ? pageCopy.clearSelection : pageCopy.selectResults}</button>}
          </div>
          </>}
          <div className="question-list">
            {!filteredQuestions.length && <div className={`empty-state ${showSelected ? "basket-empty" : ""}`}><div>{pageCopy.empty}</div><h3>{showSelected ? "组卷篮还是空的" : !activeModule ? libraryScope === "mine" ? "创建你的第一个模块" : "我的题库尚无模块" : `${activeModule.name}${pageLocale === "en" ? " " : ""}${pageCopy.noQuestions}`}</h3><p>{showSelected ? "到我的题库勾选题目，再回来调整顺序并生成练习。" : !activeModule ? libraryScope === "mine" ? "模块可以是考试、学科或你习惯的任意分组" : "等待本地管理员发布内容" : canManageLibrary ? pageCopy.addFirstQuestion : pageCopy.noResources}</p>{showSelected ? <button onClick={() => setShowSelected(false)}>去题库选题</button> : canManageLibrary ? <button onClick={activeModule ? openNewQuestion : openNewModule}>{activeModule ? pageCopy.newQuestion : pageCopy.newModule}</button> : null}</div>}
            {filteredQuestions.map((question, index) => {
              const checked = selectedIds.includes(question.id); const answerOpen = expandedAnswers.includes(question.id); const images = questionImages(question); const imageLayout = resolveQuestionImageLayout(question); const compactConclusion = isCompactConclusionQuestion(question); const visibleTags = isAlevelPage ? localizeAlevelTags(question, pageLocale) : question.tags ?? [];
              return <article className={`question-card ${checked ? "checked" : ""}`} key={question.id}>
                {authUser && !showSelected && <button className={`check ${checked ? "on" : ""}`} aria-label={pageLocale === "en" ? `${checked ? pageCopy.deselectQuestion : pageCopy.selectQuestion} question ${index + 1}` : `${checked ? pageCopy.deselectQuestion : pageCopy.selectQuestion}第 ${index + 1} 题`} onClick={() => toggleSelected(question.id)}>{checked ? "✓" : ""}</button>}
                <div className="question-main">
                  <div className="meta"><span>{alevelPageLabel(question.type, pageLocale)}</span><span className={question.difficulty === "提高" ? "hard" : question.difficulty === "中等" ? "medium" : "easy"}>{alevelPageLabel(question.difficulty, pageLocale)}</span><span className={`provenance-badge provenance-${normalizeQuestionProvenance(question.provenance) === "真题" ? "real" : normalizeQuestionProvenance(question.provenance) === "风格题" ? "style" : "pending"}`}>{alevelPageLabel(normalizeQuestionProvenance(question.provenance), pageLocale)}{question.examYear ? ` · ${question.examYear}` : ""}</span>{question.diagramSource === "svg-ai" ? <span className="geogebra-badge">{pageCopy.imageRedraw}</span> : question.diagramSource === "geogebra-ai" ? <span className="geogebra-badge">{pageCopy.legacyRedraw}</span> : question.originalImage ? <span className="image-badge">{pageCopy.imageCapture}</span> : images.length ? <span className="image-badge">{pageCopy.figure}</span> : null}{question.optimizedAt && <span className="optimized-badge">{pageCopy.aiEnhanced}</span>}<em>{pathOf(question.categoryId)}</em></div>
                  <div className={`question-presentation ${images.length ? `with-images layout-${imageLayout}${compactConclusion ? " compact-conclusion" : ""}` : ""}`}>
                    <div className="question-copy">
                      <div className="stem"><b className="question-number">{index + 1}.</b><div className="stem-body">{question.source && <span className="question-source">（{question.source}）</span>}<DocxContent xml={question.stemDocxXml} fallback={question.stem} stripLeadingQuestionNumber /></div></div>
                      {!!question.options.length && !compactConclusion && <DocxOptions xml={question.optionsDocxXml} fallback={question.options} />}
                    </div>
                    {!!images.length && <div className={`question-images ${images.length > 1 ? "multiple" : ""}`}>{images.map((image, imageIndex) => <img className="question-diagram" src={image} alt={`${pageCopy.figureAlt} ${imageIndex + 1}`} key={`${question.id}-image-${imageIndex}`} />)}</div>}
                    {!!question.options.length && compactConclusion && <DocxOptions xml={question.optionsDocxXml} fallback={question.options} />}
                  </div>
                  {!!visibleTags.length && <div className="tag-row">{visibleTags.map((tag) => <span key={`${pageLocale}-${tag}`}>{tag}</span>)}</div>}
                  {answerOpen && <div className="answer-box"><b>{pageCopy.answer}</b><p><MathText text={question.answer || pageCopy.none} /></p>{question.analysis && <><b>{pageCopy.solution}</b><div className="analysis-content">{question.studioSource ? <StudioSolution source={{...question.studioSource,analysis:question.analysis}}/> : <DocxContent xml={question.analysisDocxXml} fallback={question.analysis} />}</div></>}</div>}
                  <div className="question-actions"><button onClick={() => setExpandedAnswers((current) => current.includes(question.id) ? current.filter((id) => id !== question.id) : [...current, question.id])}>{answerOpen ? pageCopy.hideSolution : pageCopy.showSolution}</button>{question.createdByEmail && <small>{pageCopy.enteredBy} {question.createdByEmail}{pageCopy.enteredSuffix ? ` ${pageCopy.enteredSuffix}` : ""}</small>}<span></span>{!showSelected && question.canEdit && <><button onClick={() => openEditQuestion(question)}>{pageCopy.edit}</button><button className="danger-text" onClick={() => deleteQuestion(question)}>{pageCopy.delete}</button></>}{showSelected && <div className="basket-card-actions"><button disabled={index === 0 || isExporting} aria-label={`上移第 ${index + 1} 题`} onClick={() => setSelectedIds((ids) => moveBasketQuestion(ids, question.id, -1))}>↑ 上移</button><button disabled={index === filteredQuestions.length - 1 || isExporting} aria-label={`下移第 ${index + 1} 题`} onClick={() => setSelectedIds((ids) => moveBasketQuestion(ids, question.id, 1))}>↓ 下移</button><button disabled={isExporting} aria-label={`移除第 ${index + 1} 题`} onClick={() => setSelectedIds((ids) => ids.filter((id) => id !== question.id))}>移除</button></div>}</div>
                </div>
              </article>;
            })}
          </div>
          </>}
        </section>
      </section>

      {authUser && !showWrongBook && !showSelected && !!selectedQuestions.length && <aside className="paper-dock visible"><div className="dock-count"><strong>{selectedQuestions.length}</strong><span>已选试题</span></div><div className="dock-title"><b>选好题目后，进入组卷篮整理</b></div><PaperMoreMenu className="dock-more">{libraryScope === "public" && <button onClick={openCopyDialog}>复制到私人题库</button>}{selectedIds.some((id) => questions.find((item) => item.id === id)?.canEdit) && <button onClick={() => setBatchDeleteOpen(true)}>删除题库原题</button>}<button onClick={() => setSelectedIds([])}>取消全部勾选</button></PaperMoreMenu><button className="export-button" onClick={() => { setShowWrongBook(false); setShowSelected(true); }}>整理组卷 <span>→</span></button></aside>}

      {questionDraft && <div className="modal-backdrop">
        <section className="modal question-modal" role="dialog" aria-modal="true" aria-label="试题编辑" onPaste={(event) => { const file = clipboardImage(event); if (file) { event.preventDefault(); if (entryMode === "screenshot") handleQuestionImage(file); else handleManualImages([file]); } }}>
          <div className="modal-head"><div><span className="eyebrow">智能录题</span><h2>{questionDraft.id ? "编辑并校对试题" : entryMode === "manual" ? "人工录入试题" : "截图自动录题"}</h2></div><button className="close" onClick={() => setQuestionDraft(null)}>×</button></div>
          <div className="entry-mode" role="tablist" aria-label="录题方式"><button className={entryMode === "manual" ? "active" : ""} onClick={() => setEntryMode("manual")}><b>人工录入</b><span>文字与配图自由组合</span></button><button className={entryMode === "screenshot" ? "active" : ""} onClick={() => setEntryMode("screenshot")}><b>AI 截图录入</b><span>识别单道题目截图</span></button><button onClick={openFileImport}><b>文件批量录入</b><span>PDF / Word 整份导入</span></button></div>
          {entryMode === "screenshot" && (!questionDraft.originalImage ? <button type="button" className="smart-capture" onClick={() => questionImageRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) handleQuestionImage(file); }}>
            <div className="capture-icon">⌘V</div><div><b>直接粘贴题目截图</b><p>也可以点击选择图片，或把图片拖到这里</p></div><span>自动识别题干、公式、答案与配图</span>
          </button> : <div className="recognition-source">
            <div className="source-image"><img src={questionDraft.originalImage} alt="原始题目截图" />{isRecognizing && <div className="recognizing"><i></i><b>正在识别题目…</b><span>文字、公式和配图会自动拆分</span></div>}</div>
            <div className="source-status"><span className="eyebrow">原始截图已保留</span><b>{isReconstructingDiagram ? "正在提取原图轮廓并生成矢量稿" : isRecognizing ? "识别处理中" : questionDraft.recognitionConfidence != null ? `识别可信度 ${Math.round(questionDraft.recognitionConfidence * 100)}%` : "等待识别"}</b><p>下面的结果可以逐项修改，保存后仍可对照原图。</p><div><button className="secondary" disabled={isRecognizing || isReconstructingDiagram} onClick={() => recognizeImage(questionDraft.originalImage!)}>重新识别</button><button className="text-button" onClick={() => setQuestionDraft({ ...questionDraft, originalImage: undefined, diagramImage: undefined, diagramOriginalImage: undefined, diagramSource: undefined, diagramQuality: undefined, diagramBox: undefined, geogebraBase64: undefined, geogebraPlan: undefined, vectorDiagramSvg: undefined, vectorDiagramPlan: undefined, diagramReconstructionConfidence: undefined, diagramVisualFitScore: undefined, diagramReconstructionWarnings: undefined, diagramReconstructedAt: undefined, recognitionConfidence: undefined, recognitionWarnings: [] })}>移除图片</button></div></div>
          </div>)}
          <input ref={questionImageRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) handleQuestionImage(file); event.target.value = ""; }} />
          <input ref={manualImagesRef} hidden multiple type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { handleManualImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          {entryMode === "screenshot" && <label className="geogebra-toggle"><input type="checkbox" checked={enableVectorReconstruction} disabled={isRecognizing || isReconstructingDiagram} onChange={(event) => setEnableVectorReconstruction(event.target.checked)} /><span><b>低质量配图时，自动高清矢量重绘</b><small>复原原题印刷点线与标签，自动排除学生手写计算、圈画和后加辅助线；原始配图始终保留。</small></span><em>{enableVectorReconstruction ? "已开启" : "已关闭"}</em></label>}
          {entryMode === "screenshot" && recognitionError && <div className="recognition-error"><b>暂时无法自动识别</b><span>{recognitionError}</span></div>}
          {entryMode === "screenshot" && !!questionDraft.recognitionWarnings?.length && <div className="recognition-warning"><b>请重点核对</b><span>{questionDraft.recognitionWarnings.join("；")}</span></div>}
          <div className="review-divider"><span>{entryMode === "manual" ? "录入题目内容" : "识别结果 · 保存前请检查"}</span></div>
          <div className="form-grid three"><label>题型<select value={questionDraft.type} onChange={(event) => setQuestionDraft({ ...questionDraft, type: event.target.value as QuestionType })}>{questionTypes.map((item) => <option key={item}>{item}</option>)}</select></label><label>难度<select value={questionDraft.difficulty} onChange={(event) => setQuestionDraft({ ...questionDraft, difficulty: event.target.value as Difficulty })}>{difficulties.map((item) => <option key={item}>{item}</option>)}</select></label><label>题目属性<select value={normalizeQuestionProvenance(questionDraft.provenance)} onChange={(event) => setQuestionDraft({ ...questionDraft, provenance: event.target.value as QuestionProvenance })}>{QUESTION_PROVENANCES.map((item) => <option key={item}>{item}</option>)}</select></label></div>
          <div className="form-grid two"><label>所属分类<select value={questionDraft.categoryId} onChange={(event) => setQuestionDraft({ ...questionDraft, categoryId: event.target.value })}><option value="">请选择</option>{activeModule && <option value={activeModule.id}>{activeModule.name}（模块根目录）</option>}{moduleCategories.map((item) => <option key={item.id} value={item.id}>{pathOf(item.id)}</option>)}</select></label><label>年份 / 场次（选填）<input value={questionDraft.examYear ?? ""} onChange={(event) => setQuestionDraft({ ...questionDraft, examYear: event.target.value })} placeholder="如：2025 第一场" /></label></div>
          <label className="field">题干<textarea rows={4} value={questionDraft.stem} onChange={(event) => setQuestionDraft({ ...questionDraft, stem: event.target.value, stemDocxXml: undefined, stemDocxAssets: undefined })} placeholder="识别后的题干会出现在这里，也可以直接输入…" /></label>
          <div className="formula-hint"><b>可编辑公式</b><span>计算式会自动转为 Word 公式；复杂分式、根式可用 $LaTeX$ 输入，如 $\frac&#123;1&#125;&#123;2&#125;$。</span></div>
          {entryMode === "manual" && <div className="manual-image-editor" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handleManualImages(Array.from(event.dataTransfer.files)); }}>
            <div className="manual-image-head"><div><span className="eyebrow">题目配图（选填）</span><p>可添加几何图、函数图像或表格，最多 4 张；也支持直接粘贴。</p></div><button className="secondary" onClick={() => manualImagesRef.current?.click()}>＋ 添加图片</button></div>
            {questionDraft.contentImages?.length ? <div className="manual-image-grid">{questionDraft.contentImages.map((image, index) => <figure key={`manual-${index}`}><img src={image} alt={`人工添加的题目配图 ${index + 1}`} /><button aria-label={`移除第 ${index + 1} 张配图`} onClick={() => setQuestionDraft({ ...questionDraft, contentImages: questionDraft.contentImages?.filter((_, imageIndex) => imageIndex !== index) })}>×</button><figcaption>配图 {index + 1}</figcaption></figure>)}</div> : <button className="manual-image-empty" onClick={() => manualImagesRef.current?.click()}><span>＋</span> 点击、拖入或粘贴题目配图</button>}
          </div>}
          {entryMode === "screenshot" && questionDraft.diagramImage && (questionDraft.diagramSource === "svg-ai" && questionDraft.diagramOriginalImage ? <div className="diagram-review geogebra-review"><div><span className="eyebrow">原图坐标高清矢量重绘</span><p>最终图直接使用原图坐标，不再由几何引擎重新摆点。综合视觉匹配度 {Math.round((questionDraft.diagramVisualFitScore ?? 0) * 100)}%，关系识别可信度 {Math.round((questionDraft.diagramReconstructionConfidence ?? 0) * 100)}%。</p></div><div className="diagram-compare"><figure><img src={questionDraft.diagramOriginalImage} alt="重绘前的原始配图" /><figcaption>原始配图</figcaption></figure><figure><img src={questionDraft.diagramImage} alt="高清矢量重绘配图" /><figcaption>高清矢量重绘</figcaption></figure></div><div className="diagram-actions"><button className="secondary" disabled={isReconstructingDiagram} onClick={reconstructCurrentDiagram}>{isReconstructingDiagram ? "正在重绘…" : "重新渲染"}</button><button className="text-button" onClick={() => setQuestionDraft({ ...questionDraft, diagramImage: questionDraft.diagramOriginalImage, diagramOriginalImage: undefined, diagramSource: "extracted", vectorDiagramSvg: undefined, vectorDiagramPlan: undefined, diagramReconstructionConfidence: undefined, diagramVisualFitScore: undefined, diagramReconstructionWarnings: undefined, diagramReconstructedAt: undefined })}>使用原图</button></div></div> : <div className="diagram-review"><div><span className="eyebrow">清理后的独立配图</span><p>{isReconstructingDiagram ? "正在提取原图轮廓、标签位置和视觉比例…" : "已自动从截图中分离，保存后只展示这张图。"}</p></div><img src={questionDraft.diagramImage} alt="识别出的题目配图" /><div className="diagram-actions"><button className="secondary" onClick={beginManualCrop}>手动框选</button>{questionDraft.diagramQuality?.reconstructable && <button className="secondary" disabled={isReconstructingDiagram} onClick={reconstructCurrentDiagram}>高清矢量重绘</button>}<button className="text-button" onClick={() => setQuestionDraft({ ...questionDraft, diagramImage: undefined, diagramBox: undefined, diagramOriginalImage: undefined, diagramSource: undefined, vectorDiagramSvg: undefined, vectorDiagramPlan: undefined, diagramReconstructionConfidence: undefined, diagramVisualFitScore: undefined, diagramReconstructionWarnings: undefined, diagramReconstructedAt: undefined })}>移除</button></div></div>)}
          {!!questionImages(questionDraft).length && <div className="layout-choice"><div><span className="eyebrow">图文排列</span><p>{questionDraft.stemDocxXml?.length ? "文件录入题会按篇幅、分问和配图数量自动选择合适结构。" : isGeometryQuestion(questionDraft) ? "网页端题干左、配图右；导出 Word 时自动改为题干下、配图右。" : "网页端可左右展示以节省空间，Word 导出会使用更稳妥的上下结构。"}</p></div><div>{questionDraft.stemDocxXml?.length ? <button className="active">{resolveQuestionImageLayout(questionDraft) === "right" ? "网页 · 题干左配图右" : resolveQuestionImageLayout(questionDraft) === "below-right" ? "网页 · 题干上配图右下" : "网页 · 题干上配图左下"}</button> : isGeometryQuestion(questionDraft) ? <button className="active">网页 · 题干左配图右</button> : <><button className={(questionDraft.imageLayout ?? "right") === "right" ? "active" : ""} onClick={() => setQuestionDraft({ ...questionDraft, imageLayout: "right" })}>题干左 · 配图右</button><button className={questionDraft.imageLayout === "below" ? "active" : ""} onClick={() => setQuestionDraft({ ...questionDraft, imageLayout: "below" })}>题干上 · 配图下</button></>}</div></div>}
          {["单选题", "多选题"].includes(questionDraft.type) && <div className="field"><span>选项</span><div className="option-inputs">{questionDraft.options.map((option, index) => <label key={index}><b>{String.fromCharCode(65 + index)}</b><input value={option} onChange={(event) => { const options = [...questionDraft.options]; options[index] = event.target.value; setQuestionDraft({ ...questionDraft, options, optionsDocxXml: undefined, optionsDocxAssets: undefined }); }} placeholder={`选项 ${String.fromCharCode(65 + index)}`} /></label>)}</div></div>}
          <div className="form-grid two"><label>答案<input value={questionDraft.answer} onChange={(event) => setQuestionDraft({ ...questionDraft, answer: event.target.value })} placeholder="如：B 或 √5" /></label><label>详细来源（选填）<input value={questionDraft.source} onChange={(event) => setQuestionDraft({ ...questionDraft, source: event.target.value })} placeholder={`如：${activeModule?.name ?? "当前模块"}回忆版 · 第 12 题`} /></label></div>
          {questionDraftIsAlevel ? <div className="bilingual-tag-fields">
            <label className="field"><span>中文知识点</span><input aria-label="中文知识点标签" value={alevelTagVersions(questionDraft).zh.join("，")} onChange={(event) => { const tagsZh = parseTagInput(event.target.value); setQuestionDraft({ ...questionDraft, tags: tagsZh, tagsZh }); }} placeholder="如：三角函数应用" /></label>
            <label className="field"><span>English topics</span><input aria-label="English topic tags" lang="en" value={alevelTagVersions(questionDraft).en.join(", ")} onChange={(event) => setQuestionDraft({ ...questionDraft, tagsEn: parseTagInput(event.target.value) })} placeholder="e.g. Modelling with Trigonometric Functions" /></label>
            <p>两边按相同顺序一一对应；截图识别后也请在保存前校对。</p>
          </div> : <label className="field">知识点标签（用逗号分隔）<input value={(questionDraft.tags ?? []).join("，")} onChange={(event) => setQuestionDraft({ ...questionDraft, tags: parseTagInput(event.target.value) })} placeholder="如：手拉手模型，旋转型全等" /></label>}
          <label className="field">解析（选填）<textarea rows={3} value={questionDraft.analysis} onChange={(event) => setQuestionDraft({ ...questionDraft, analysis: event.target.value, analysisDocxXml: undefined, analysisDocxAssets: undefined })} placeholder="截图中有解析时会自动识别，也可以手工补充…" /></label>
          {optimizationError && <div className="recognition-error"><b>AI 优化未完成</b><span>{optimizationError}</span></div>}
          {optimizationPreview && <section className="optimization-preview">
            <div className="optimization-title"><div><span className="eyebrow">AI 优化预览</span><h3>确认无误后再采用</h3></div><span className="layout-recommendation">网页建议：{optimizationPreview.image_layout === "right" ? "题干左 · 配图右" : optimizationPreview.image_layout === "below-right" ? "题干上 · 配图右下" : "题干上 · 配图左下"}</span></div>
            <div className="optimization-compare"><div><b>优化前</b><p><MathText text={questionDraft.stem} /></p></div><div><b>优化后</b><p><MathText text={optimizationPreview.stem} /></p></div></div>
            <div className="optimization-changes"><b>本次调整</b><span>{optimizationPreview.changes.join("；")}</span></div>
            <div className="optimization-actions"><button className="text-button" onClick={() => setOptimizationPreview(null)}>暂不采用</button><button className="primary-button" onClick={applyOptimization}>采用优化结果</button></div>
          </section>}
          <div className="modal-actions"><small className="save-note">真题请注明年份与来源；不确定时保留“来源待核实”</small><button className="ai-button" disabled={isRecognizing || isOptimizing || isReconstructingDiagram} onClick={optimizeDraft}>{isOptimizing ? <><i></i>AI 正在优化…</> : "✦ AI 优化排版"}</button><button className="secondary" onClick={() => setQuestionDraft(null)}>取消</button><button className="primary-button" disabled={isRecognizing || isOptimizing || isReconstructingDiagram} onClick={persistQuestion}>确认并保存</button></div>
        </section>
      </div>}

      {fileImportOpen && <div className="modal-backdrop"><section className="modal file-import-modal" role="dialog" aria-modal="true" aria-label="文件批量录入">
        <div className="modal-head"><div><span className="eyebrow">第三种录题方式</span><h2>PDF / Word 批量录入</h2></div><button className="close" onClick={closeFileImport}>×</button></div>
        {fileImportStep === "choose" && <>
          <div className="file-import-intro"><span>01</span><div><b>整份文件逐页识别</b><p>自动拆分题目、选项、答案和配图，识别后统一校对再保存。</p></div></div>
          <label className="field">默认存入分类<select value={fileImportCategory} onChange={(event) => setFileImportCategory(event.target.value)}><option value="">请选择分类</option>{activeModule && <option value={activeModule.id}>{activeModule.name}（模块根目录）</option>}{moduleCategories.map((item) => <option key={item.id} value={item.id}>{pathOf(item.id)}</option>)}</select></label>
          <button className="file-dropzone" onClick={() => fileImportRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) handleImportDocument(file); }}><strong>选择或拖入文件</strong><span>支持 PDF、Word（.docx），最多 80 页 / 80MB</span><small>旧版 .doc 请先在 Word 中另存为 .docx</small></button>
          <input ref={fileImportRef} hidden type="file" accept="application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => { const file = event.target.files?.[0]; if (file) handleImportDocument(file); event.target.value = ""; }} />
          {!!fileImportErrors.length && <div className="recognition-error"><b>文件未能读取</b><span>{fileImportErrors.join("；")}</span></div>}
          <div className="file-privacy-note">文件只在当前页面转换；正式题库仅保存你确认过的题目内容。</div>
        </>}
        {(fileImportStep === "rendering" || fileImportStep === "recognizing") && <div className="file-processing"><div className="file-spinner"><i></i><span>{fileImportStep === "rendering" ? "读取文件" : "AI 拆分题目"}</span></div><h3>{fileImportProgress.label}</h3><div className="progress-track"><i style={{ width: `${fileImportProgress.total ? fileImportProgress.current / fileImportProgress.total * 100 : 8}%` }}></i></div><p>{fileImportStep === "rendering" ? "正在把页面还原成清晰图片" : "正在识别题干、选项、答案、分类与配图"}</p><button className="secondary" onClick={closeFileImport}>取消导入</button></div>}
        {fileImportStep === "review" && <>
          <div className="file-review-summary"><div><strong>{fileImportDrafts.length}</strong><span>道待校对题目</span></div><p>{fileImportName} · 已选择 {fileImportDrafts.filter((item) => item.selected).length} 道</p><button className="secondary" onClick={() => setFileImportDrafts((current) => current.map((item) => ({ ...item, selected: !current.every((entry) => entry.selected) })))}>{fileImportDrafts.every((item) => item.selected) ? "取消全选" : "全部选择"}</button></div>
          {!!fileImportErrors.length && <div className="recognition-warning"><b>部分页面需留意</b><span>{fileImportErrors.join("；")}</span></div>}
          {!fileImportDrafts.length ? <div className="file-empty-result"><b>没有识别到完整题目</b><p>请确认文件页面清晰且包含题号，再重新选择文件。</p><button className="secondary" onClick={() => setFileImportStep("choose")}>重新选择</button></div> : <div className="file-draft-list">{fileImportDrafts.map((item, index) => <article className={`file-draft ${item.selected ? "selected" : ""}`} key={item.importId}>
            <div className="file-draft-head"><label><input type="checkbox" checked={item.selected} onChange={(event) => updateImportDraft(item.importId, { selected: event.target.checked })} /><b>第 {index + 1} 题</b></label><span>{item.sourcePage ? `文件第 ${item.sourcePage} 页` : `Word 原题 ${item.documentNumber || index + 1}`} · 可信度 {Math.round((item.recognitionConfidence ?? 0) * 100)}%</span><button onClick={() => setFileImportDrafts((current) => current.filter((entry) => entry.importId !== item.importId))}>移除</button></div>
            <div className="file-draft-fields"><label>题型<select value={item.type} onChange={(event) => updateImportDraft(item.importId, { type: event.target.value as QuestionType })}>{questionTypes.map((type) => <option key={type}>{type}</option>)}</select></label><label>难度<select value={item.difficulty} onChange={(event) => updateImportDraft(item.importId, { difficulty: event.target.value as Difficulty })}>{difficulties.map((difficulty) => <option key={difficulty}>{difficulty}</option>)}</select></label><label>题目属性<select value={normalizeQuestionProvenance(item.provenance)} onChange={(event) => updateImportDraft(item.importId, { provenance: event.target.value as QuestionProvenance })}>{QUESTION_PROVENANCES.map((provenance) => <option key={provenance}>{provenance}</option>)}</select></label><label className="wide">分类<select value={item.categoryId} onChange={(event) => updateImportDraft(item.importId, { categoryId: event.target.value })}><option value="">请选择</option>{activeModule && <option value={activeModule.id}>{activeModule.name}（模块根目录）</option>}{moduleCategories.map((category) => <option key={category.id} value={category.id}>{pathOf(category.id)}</option>)}</select></label></div>
            <label className="field">题干<textarea rows={3} value={item.stem} onChange={(event) => updateImportDraft(item.importId, { stem: event.target.value })} /></label>
            {!!questionImages(item).length && <div className="file-draft-media"><div className="file-draft-images">{questionImages(item).map((image, imageIndex) => <img src={image} alt={`第 ${index + 1} 题配图 ${imageIndex + 1}`} key={`${item.importId}-preview-${imageIndex}`} />)}</div><span>{item.diagramSource === "svg-ai" ? `高清矢量重绘 · 视觉匹配度 ${Math.round((item.diagramVisualFitScore ?? 0) * 100)}%` : `已保留 ${questionImages(item).length} 张原始配图`}</span></div>}
            {!!importedDocxTableCount(item) && <div className="file-draft-structure">已保留 {importedDocxTableCount(item)} 个 Word 原表格，导出时沿用原行列与公式结构</div>}
            {item.type === "单选题" || item.type === "多选题" ? <label className="field">选项（每行一个）<textarea rows={Math.max(2, item.options.length)} value={item.options.join("\n")} onChange={(event) => updateImportDraft(item.importId, { options: event.target.value.split("\n") })} /></label> : null}
            <div className="file-draft-answer"><label>答案<input value={item.answer} onChange={(event) => updateImportDraft(item.importId, { answer: event.target.value })} /></label><label>来源<input value={item.source} onChange={(event) => updateImportDraft(item.importId, { source: event.target.value })} /></label></div>
            {isAlevelPage ? <div className="file-draft-answer bilingual-file-tags"><label>中文知识点<input aria-label={`第 ${index + 1} 题中文知识点标签`} value={alevelTagVersions(item).zh.join("，")} onChange={(event) => { const tagsZh = parseTagInput(event.target.value); updateImportDraft(item.importId, { tags: tagsZh, tagsZh }); }} placeholder="如：一元二次方程" /></label><label>English topics<input lang="en" aria-label={`Question ${index + 1} English topic tags`} value={alevelTagVersions(item).en.join(", ")} onChange={(event) => updateImportDraft(item.importId, { tagsEn: parseTagInput(event.target.value) })} placeholder="e.g. Quadratic Equations" /></label></div> : <label className="field file-draft-tags">知识点标签（用逗号分隔）<input value={(item.tags ?? []).join("，")} onChange={(event) => updateImportDraft(item.importId, { tags: parseTagInput(event.target.value) })} /></label>}
            {!!item.recognitionWarnings?.length && <p className="file-draft-warning">请核对：{item.recognitionWarnings.join("；")}</p>}
          </article>)}</div>}
          <div className="modal-actions file-import-actions"><button className="secondary" onClick={() => setFileImportStep("choose")}>重新选择文件</button><button className="primary-button" disabled={!fileImportDrafts.some((item) => item.selected)} onClick={saveImportedQuestions}>保存所选 {fileImportDrafts.filter((item) => item.selected).length} 道题</button></div>
        </>}
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

      {categoryDialog && activeModule && <div className="modal-backdrop"><section className="modal category-modal" role="dialog" aria-modal="true" aria-label="分类管理">
        <div className="modal-head"><div><span className="eyebrow">{activeModule.name}</span><h2>{categoryDialog === "new" ? "新建模块内分类" : "分类与数据管理"}</h2></div><button className="close" onClick={() => setCategoryDialog(null)}>×</button></div>
        {categoryDialog === "new" ? <>
          <label className="field">分类名称<input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="例如：二次函数" /></label>
          <label className="field">上级分类<select value={categoryParent || activeModule.id} onChange={(event) => setCategoryParent(event.target.value)}><option value={activeModule.id}>{activeModule.name}（模块根目录）</option>{moduleCategories.map((item) => <option key={item.id} value={item.id}>{pathOf(item.id)}</option>)}</select></label>
          <div className="modal-actions"><button className="secondary" onClick={() => setCategoryDialog(null)}>取消</button><button className="primary-button" onClick={createCategory}>创建分类</button></div>
        </> : <>
          <div className="manage-list">{moduleCategories.length ? moduleCategories.map((item) => <div key={item.id}><span><b>{item.name}</b><small>{pathOf(item.id)} · {countFor(item.id)} 题</small></span><button onClick={() => deleteCategory(item)}>删除</button></div>) : <p className="empty-tree">当前模块还没有子分类</p>}</div>
          <div className="data-tools"><div><b>{libraryScope === "public" ? "公共编辑库" : "我的题库"}备份</b><small>备份包含动态模块、分类和题目；导入会追加到当前题库。</small></div><button className="secondary" onClick={() => importRef.current?.click()}>导入备份</button><button className="secondary" onClick={exportBackup}>导出备份</button><input ref={importRef} type="file" accept="application/json" hidden onChange={importBackup} /></div>
          <div className="modal-actions"><button className="secondary" onClick={() => { setCategoryParent(activeCategory ?? activeModule.id); setCategoryDialog("new"); }}>＋ 新建分类</button><button className="primary-button" onClick={() => setCategoryDialog(null)}>完成</button></div>
        </>}
      </section></div>}

      {moduleDialog && <div className="modal-backdrop"><section className="modal module-modal" role="dialog" aria-modal="true" aria-label="模块管理">
        <div className="modal-head"><div><span className="eyebrow">{libraryScope === "public" ? pageCopy.publicLibrary : pageCopy.myLibrary}</span><h2>{moduleDialog === "new" ? moduleDraft ? "编辑模块" : "新建模块" : "模块管理"}</h2></div><button className="close" onClick={() => { setModuleDialog(null); setModuleDraft(null); }}>×</button></div>
        {moduleDialog === "new" ? <>
          <label className="field">模块名称<input value={moduleName} onChange={(event) => setModuleName(event.target.value)} placeholder="例如：深圳中考" /></label>
          <label className="field">副标题<input value={moduleSubtitle} onChange={(event) => setModuleSubtitle(event.target.value)} placeholder="例如：数学真题与专题训练" /></label>
          <div className="modal-actions"><button className="secondary" onClick={() => setModuleDialog(moduleDraft ? "manage" : null)}>取消</button><button className="primary-button" onClick={saveModule}>{moduleDraft ? "保存修改" : "创建模块"}</button></div>
        </> : <>
          <div className="module-manage-list">{modules.map((item, index) => <div key={item.id} draggable onDragStart={() => setDraggedModuleId(item.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropModule(item.id)}>
            <span className="drag-handle" title="拖动排序">⋮⋮</span><span><b>{item.name}</b><small>{item.subtitle || "未设置副标题"} · {countFor(item.id)} 题</small></span><div><button title="上移" aria-label={`上移${item.name}`} disabled={index === 0} onClick={() => moveModule(item.id, -1)}>↑</button><button title="下移" aria-label={`下移${item.name}`} disabled={index === modules.length - 1} onClick={() => moveModule(item.id, 1)}>↓</button><button onClick={() => openModuleEditor(item)}>编辑</button><button className="danger-text" onClick={() => { setDeleteModuleTarget(item); setDeleteModuleConfirmation(""); }}>删除</button></div>
          </div>)}</div>
          <div className="modal-actions"><button className="secondary" onClick={openNewModule}>＋ 新建模块</button><button className="primary-button" onClick={() => setModuleDialog(null)}>完成</button></div>
        </>}
      </section></div>}

      {deleteModuleTarget && <div className="modal-backdrop modal-backdrop-raised"><section className="modal delete-modal" role="dialog" aria-modal="true" aria-label="删除模块">
        <div className="modal-head"><div><span className="eyebrow">危险操作</span><h2>删除“{deleteModuleTarget.name}”</h2></div><button className="close" onClick={() => setDeleteModuleTarget(null)}>×</button></div>
        <div className="delete-summary"><strong>{questions.filter((item) => item.moduleId === deleteModuleTarget.id).length}</strong><div><b>道题及 {categories.filter((item) => item.moduleId === deleteModuleTarget.id).length} 个分类将一并删除</b><p>该操作无法撤销。请输入完整模块名称确认。</p></div></div>
        <label className="field">输入“{deleteModuleTarget.name}”<input value={deleteModuleConfirmation} onChange={(event) => setDeleteModuleConfirmation(event.target.value)} /></label>
        <div className="modal-actions"><button className="secondary" onClick={() => setDeleteModuleTarget(null)}>取消</button><button className="danger-button" disabled={deleteModuleConfirmation !== deleteModuleTarget.name} onClick={confirmDeleteModule}>确认删除</button></div>
      </section></div>}

      {studentDialog && <div className="modal-backdrop"><section className="modal student-modal" role="dialog" aria-modal="true" aria-label={studentDraft ? "编辑学生档案" : "新建学生档案"}>
        <div className="modal-head"><div><span className="eyebrow">学生专属空间</span><h2>{studentDraft ? "编辑学生档案" : "新建学生档案"}</h2></div><button className="close" onClick={() => setStudentDialog(false)}>×</button></div>
        <label className="field">学生姓名或昵称<input value={studentName} onChange={(event) => setStudentName(event.target.value)} placeholder="例如：小宇" /></label>
        <label className="field">班级 / 年级（选填）<input value={studentClassName} onChange={(event) => setStudentClassName(event.target.value)} placeholder="例如：初三（2）班" /></label>
        <label className="field">学习备注（选填）<textarea rows={4} value={studentNotes} onChange={(event) => setStudentNotes(event.target.value)} placeholder="例如：几何基础较好，函数综合题需要加强" /></label>
        <div className="modal-actions"><button className="secondary" onClick={() => setStudentDialog(false)}>取消</button><button className="primary-button" onClick={saveStudent}>{studentDraft ? "保存档案" : "创建学生"}</button></div>
      </section></div>}

      {wrongEntryDraft && <div className="modal-backdrop"><section className="modal wrong-entry-modal" role="dialog" aria-modal="true" aria-label="编辑错题记录">
        <div className="modal-head"><div><span className="eyebrow">{activeStudent?.name ?? "学生"}的错题</span><h2>编辑复习记录</h2></div><button className="close" onClick={() => setWrongEntryDraft(null)}>×</button></div>
        <div className="wrong-entry-preview"><span>{wrongEntryDraft.question.type}</span><p>{wrongEntryDraft.question.stem.replace(/\s+/g, " ").slice(0, 120)}</p></div>

        <label className="field">错因 / 复习备注<textarea rows={5} value={wrongEntryDraft.note} onChange={(event) => setWrongEntryDraft({ ...wrongEntryDraft, note: event.target.value })} placeholder="记录学生当时的错误原因或下次复习重点" /></label>
        <label className="toggle-row" aria-label="错题掌握状态"><input type="checkbox" checked={wrongEntryDraft.mastered} onChange={(event) => setWrongEntryDraft({ ...wrongEntryDraft, mastered: event.target.checked })} /><span><b>这道题已掌握</b><small>取消勾选后会回到“复习中”</small></span></label>
        <div className="modal-actions"><button className="secondary" onClick={() => setWrongEntryDraft(null)}>取消</button><button className="primary-button" onClick={saveWrongEntry}>保存记录</button></div>
      </section></div>}

      {copyDialog && <div className="modal-backdrop"><section className="modal copy-modal" role="dialog" aria-modal="true" aria-label="复制公共题目">
        <div className="modal-head"><div><span className="eyebrow">复制 {selectedIds.length} 道公共题目</span><h2>存入私人题库</h2></div><button className="close" onClick={() => setCopyDialog(false)}>×</button></div>
        {copyTargetData?.modules.length ? <><label className="field">目标模块<select value={copyTargetModule} onChange={(event) => { setCopyTargetModule(event.target.value); setCopyTargetCategory(event.target.value); }}>{copyTargetData.modules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field">目标分类<select value={copyTargetCategory} onChange={(event) => setCopyTargetCategory(event.target.value)}><option value={copyTargetModule}>{copyTargetData.modules.find((item) => item.id === copyTargetModule)?.name}（模块根目录）</option>{copyTargetData.categories.filter((item) => item.moduleId === copyTargetModule).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="modal-actions"><button className="secondary" onClick={() => setCopyDialog(false)}>取消</button><button className="primary-button" onClick={confirmCopyQuestions}>创建独立副本</button></div></> : <div className="copy-empty"><b>私人题库还没有模块</b><p>先创建私人模块，再回来复制题目。</p><button className="primary-button" onClick={async () => { setCopyDialog(false); await switchLibraryScope("mine"); openNewModule(); }}>创建私人模块</button></div>}
      </section></div>}

      {exportDialog && <div className="modal-backdrop"><section className="modal export-modal" role="dialog" aria-modal="true" aria-label="生成 Word"><div className="modal-head"><div><span className="eyebrow">Word 组卷</span><h2>生成练习题</h2></div><button className="close" onClick={() => setExportDialog(false)}>×</button></div><div className="export-summary"><strong>{selectedIds.length}</strong><span>道试题将按组卷篮顺序排入文档</span></div><label className="field">练习标题<input value={paperTitle} onChange={(event) => setPaperTitle(event.target.value)} /></label><label className="toggle-row" aria-label="答案设置"><input type="checkbox" checked={includeAnswers} onChange={(event) => setIncludeAnswers(event.target.checked)} /><span><b>附带答案与解析</b><small>在练习题末尾另起一页</small></span></label><div className="modal-actions"><button className="secondary" onClick={() => setExportDialog(false)}>取消</button><button className="primary-button" disabled={isExporting} onClick={generateWord}>{isExporting ? "正在生成…" : "下载 .docx"}</button></div></section></div>}

      {batchDeleteOpen && <div className="modal-backdrop"><section className="modal delete-modal" role="dialog" aria-modal="true" aria-label="批量删除试题"><div className="modal-head"><div><span className="eyebrow">危险操作</span><h2>批量删除试题</h2></div><button className="close" onClick={() => setBatchDeleteOpen(false)}>×</button></div><div className="delete-summary"><strong>{selectedIds.length}</strong><div><b>道已选试题将从题库中删除</b><p>已导出的 Word 不受影响，但题库中的数据删除后无法恢复。需要保留时，请先导出题库备份。</p></div></div><div className="modal-actions"><button className="secondary" onClick={() => setBatchDeleteOpen(false)}>取消</button><button className="danger-button" onClick={deleteSelectedQuestions}>确认删除 {selectedIds.length} 道</button></div></section></div>}
      {authDialog && <div className="modal-backdrop"><section className="modal auth-modal" role="dialog" aria-modal="true" aria-label={authMode === "login" ? "登录" : "注册"}>
        <div className="modal-head"><div><span className="eyebrow">Mitty 云端题库</span><h2>{authMode === "login" ? "邮箱登录" : "使用邀请码注册"}</h2></div><button className="close" onClick={() => setAuthDialog(false)}>×</button></div>
        <div className="auth-tabs"><button className={authMode === "login" ? "active" : ""} onClick={() => { setAuthMode("login"); setAuthError(""); }}>登录</button><button className={authMode === "register" ? "active" : ""} onClick={() => { setAuthMode("register"); setAuthError(""); }}>注册</button></div>
        <label className="field">邮箱<input type="email" autoComplete="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="name@example.com" /></label>
        <label className="field">密码<input type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="至少 8 个字符" onKeyDown={(event) => { if (event.key === "Enter") submitAuth(); }} /></label>
        {authMode === "register" && <label className="field">邀请码<input value={authInvite} onChange={(event) => setAuthInvite(event.target.value)} placeholder="请输入管理员提供的邀请码" onKeyDown={(event) => { if (event.key === "Enter") submitAuth(); }} /></label>}
        {authError && <div className="recognition-error"><b>{authMode === "login" ? "登录未完成" : "注册未完成"}</b><span>{authError}</span></div>}
        <p className="auth-note">访客无需登录即可浏览题目；注册后可以录题、组卷和下载 Word。普通会员只能修改自己录入的题目。</p>
        <div className="modal-actions"><button className="secondary" onClick={() => setAuthDialog(false)}>取消</button><button className="primary-button" disabled={authSubmitting || !authEmail || !authPassword || (authMode === "register" && !authInvite)} onClick={submitAuth}>{authSubmitting ? "请稍候…" : authMode === "login" ? "登录" : "注册并登录"}</button></div>
      </section></div>}
      {notice && <div className="toast">✓ {notice}</div>}
    </main>
  );
}
