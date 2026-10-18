"use client";

import { ChangeEvent, Fragment, lazy, memo, useCallback, type MouseEvent, type SetStateAction, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CategoryTree, type TreeLight } from "./components/CategoryTree";
import { DocxContent } from "./components/DocxContent";
import { MathText } from "./components/MathText";
import { StudioSolution } from "./components/StudioSolution";
import { PaperMoreMenu } from "./components/PaperMoreMenu";
import { useConfirm } from "./components/ConfirmDialog";
import { useToast } from "./components/Toast";
import { SiteHeader } from "./components/SiteHeader";
import { AssignPlan, StudentHomework } from "./components/StudentHomework";
import { homeworkApi } from "../lib/homework-api-client";
import { StudentProfile } from "./components/StudentProfile";
import { StudentReports } from "./components/StudentReports";
import { WrongQuestionEvidence } from "./components/WrongQuestionEvidence";
import WrongQuestionUpload from "./components/WrongQuestionUpload";
import { QuestionBody } from "./components/QuestionBody";
import { BasketOutline } from "./components/BasketOutline";
import LibraryKnowledgeMap, { KnowledgeMapRail, type KnowledgeMapFocus } from "./components/knowledge-graph/LibraryKnowledgeMap";
import { editableQuestionDraft, newQuestionDraft, QuestionEntry } from "./components/QuestionEntry";
import { basketIds, basketQuestionTypes as questionTypes, basketSections, basketStorage, groupBasketByType, moveBasketQuestion, orderedBasketQuestions, placeBasketQuestion, restoreBasketDraft, selectBasketQuestions, type BasketDraft, type BasketStructure } from "../lib/paper-basket";
import { buildQuestionsWordBlob, buildWordBlob, downloadWordBlob } from "../lib/export-word";
import { categoryDescendants, categoryPath, questionMatchesKeyword } from "../lib/library-tree";
import { authorizeDownload, createCloudCategory, createCloudModule, createStudent as createStudentProfile, deleteCloudCategory, deleteCloudModule, deleteCloudQuestion, deleteStudent as deleteStudentProfile, deleteWrongQuestion, fetchDeletedQuestions, fetchLibrary, fetchWrongQuestionCatalog, fetchMe, fetchStudents, fetchWrongQuestions, importCloudLibrary, login, logout, register, reorderCloudModules, restoreCloudQuestion, restoreWrongQuestion, saveStudentClass, deleteStudentClass, updateCloudModule, updateStudent as updateStudentProfile } from "../lib/api-client";
import { ALEVEL_PAGE_COPY, ALEVEL_PAGE_LOCALE_KEY, alevelPageLabel, alevelQuestionCount, isAlevel9709ModuleName, localizeAlevelTags, type AlevelPageLocale } from "../lib/alevel-page-locale.mjs";
import { randomClientId } from "../lib/client-random-id.mjs";
import { WRONG_QUESTION_DELETED, type AuthUser, type Category, type HomeworkProgress, type LibraryData, type LibraryModule, type Question, type QuestionType, type Student, type StudentSummary, type TypesetSettings, type WrongQuestionCatalogItem, type WrongQuestionEntry } from "../lib/types";

// The sidebar is hidden on phones, so the student picker there also offers creating a student.
const NEW_STUDENT_OPTION = "__new_student__";
// 学生档案 opens on the tab last used (or the one a link names, ?tab=homework).
type ArchiveTab = "homework" | "profile" | "report" | "wrong";
const ARCHIVE_TABS: Array<[ArchiveTab, string]> = [["homework", "作业"], ["profile", "定档"], ["report", "学情报告"], ["wrong", "错题本"]];
const ARCHIVE_TAB_KEY = "student-archive-tab";
const KNOWLEDGE_MAP_KEY = "library-knowledge-map";
// The list shows 40 cards and adds 40 more before the reader reaches the end. Rendering a whole category at once
// (计算专题 has 948 questions) rebuilds every card and formula on each click and makes the page lag.
const LIBRARY_PAGE = 40;
// A new list paints its first few cards on their own, so the page shows sooner; the rest of the first 40 follow below.
const LIBRARY_FIRST = 8;
// 组卷篮 opens 快速排版 in place; the typesetter loads only then.
const Typesetter = lazy(() => import("./tools/typeset/Typesetter"));

function uid(prefix: string) { return `${prefix}-${randomClientId()}`; }

// A wrong-book question's pictures sit with the student's homework; joining the library sends them along as files.
async function inlineHomeworkImages(value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    if (!value.startsWith("/api/homework-assets/")) return value;
    const response = await fetch(value);
    if (!response.ok) throw new Error("错题配图读取失败，请稍后重试");
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("错题配图读取失败")); reader.readAsDataURL(blob); });
  }
  if (Array.isArray(value)) return Promise.all(value.map(inlineHomeworkImages));
  if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await inlineHomeworkImages(item)] as const)));
  return value;
}
function currentTimestamp() { return Date.now(); }

type CardActions = { toggleSelected: (id: string) => void; toggleAnswer: (id: string) => void; edit: (question: Question) => void; remove: (question: Question) => void; move: (id: string, direction: -1 | 1) => void; drop: (id: string) => void; activate: (id: string) => void; hover: (id: string) => void; place: (id: string, sectionId: string | null) => void };

// A click anywhere on a selectable card ticks it, as its check box does. Buttons, links and the grading record keep
// their own clicks, and dragging across the text to copy it ticks nothing.
function selectOnCardClick(event: MouseEvent<HTMLElement>, toggle: () => void) {
  if ((event.target as Element).closest("button, a, details")) return;
  if (window.getSelection()?.isCollapsed === false) return;
  toggle();
}

// One card of the library list. It re-renders only when its own question or state changes, so ticking one question
// in a long category does not rebuild every other card on the page.
const LibraryQuestionCard = memo(function LibraryQuestionCard({ question, index, isLast, isFirst = index === 0, sectionId, sections, path, checked, active = false, answerOpen, selectable, basket, canDelete, isExporting, isAlevelPage, pageLocale, actions }: {
  question: Question; index: number; isLast: boolean; path: string; checked: boolean; active?: boolean; answerOpen: boolean; selectable: boolean; basket: boolean;
  canDelete: boolean; isExporting: boolean; isAlevelPage: boolean; pageLocale: AlevelPageLocale; actions: CardActions;
  isFirst?: boolean; sectionId?: string | null; sections?: Array<{ id: string | null; title: string }>;
}) {
  const pageCopy = ALEVEL_PAGE_COPY[pageLocale];
  const visibleTags = isAlevelPage ? localizeAlevelTags(question, pageLocale) : question.tags ?? [];
  // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- The check box is the keyboard control; a click on the card is a pointer shortcut for it.
  return <article id={basket ? `basket-question-${question.id}` : undefined} tabIndex={basket ? -1 : undefined} className={`question-card ${checked ? "checked" : ""} ${active ? "active" : ""}`} onClick={selectable ? (event) => selectOnCardClick(event, () => actions.toggleSelected(question.id)) : basket ? (event) => selectOnCardClick(event, () => actions.activate(question.id)) : undefined}
    onPointerEnter={selectable ? () => actions.hover(question.id) : undefined} onPointerLeave={selectable ? () => actions.hover("") : undefined}>
    {selectable && <button className={`check ${checked ? "on" : ""}`} aria-label={pageLocale === "en" ? `${checked ? pageCopy.deselectQuestion : pageCopy.selectQuestion} question ${index + 1}` : `${checked ? pageCopy.deselectQuestion : pageCopy.selectQuestion}第 ${index + 1} 题`} onClick={() => actions.toggleSelected(question.id)}>{checked ? "✓" : ""}</button>}
    <div className="question-main">
      <div className="meta">{question.code && <span>ID {question.code}</span>}<span>{alevelPageLabel(question.type, pageLocale)}</span><span className={question.difficulty === "提高" ? "hard" : question.difficulty === "中等" ? "medium" : "easy"}>{alevelPageLabel(question.difficulty, pageLocale)}</span>{path && <em>{path}</em>}</div>
      <QuestionBody question={question} number={index + 1} figureAlt={pageCopy.figureAlt} />
      {!!visibleTags.length && <div className="tag-row">{visibleTags.map((tag) => <span key={`${pageLocale}-${tag}`}>{tag}</span>)}</div>}
      {answerOpen && <div className="answer-box"><b>{pageCopy.answer}</b><p><MathText text={question.answer || pageCopy.none} /></p>{question.analysis && <><b>{pageCopy.solution}</b><div className="analysis-content">{question.studioSource ? <StudioSolution source={{...question.studioSource,analysis:question.analysis}}/> : <DocxContent xml={question.analysisDocxXml} fallback={question.analysis} />}</div></>}</div>}
      <div className="question-actions"><button onClick={() => actions.toggleAnswer(question.id)}>{answerOpen ? pageCopy.hideSolution : pageCopy.showSolution}</button>{(question.createdBy === "local-admin" || question.createdByEmail) && <small>{question.createdBy === "local-admin" ? pageLocale === "en" ? "Entered by local admin" : "本机管理员 录入" : <>{pageCopy.enteredBy} {question.createdByEmail}{pageCopy.enteredSuffix ? ` ${pageCopy.enteredSuffix}` : ""}</>}</small>}<span></span>{!basket && question.canEdit && <><button onClick={() => actions.edit(question)}>{pageCopy.edit}</button>{canDelete && <PaperMoreMenu label={pageLocale === "en" ? `Question ${index + 1} actions` : `第 ${index + 1} 题操作`}><button className="danger-text" onClick={() => actions.remove(question)}>{pageCopy.delete}</button></PaperMoreMenu>}</>}{basket && <div className="basket-card-actions">{!!sections?.some((section) => section.id !== sectionId) && <label className="basket-move-to">移动到<select aria-label={`第 ${index + 1} 题移动到`} disabled={isExporting} value={sectionId ?? ""} onChange={(event) => actions.place(question.id, event.target.value || null)}>{sections.map((section) => <option key={section.id ?? "unassigned"} value={section.id ?? ""}>{section.title}</option>)}</select></label>}<button disabled={isFirst || isExporting} aria-label={`上移第 ${index + 1} 题`} onClick={() => actions.move(question.id, -1)}>↑ 上移</button><button disabled={isLast || isExporting} aria-label={`下移第 ${index + 1} 题`} onClick={() => actions.move(question.id, 1)}>↓ 下移</button><button disabled={isExporting} aria-label={`移除第 ${index + 1} 题`} onClick={() => actions.drop(question.id)}>移除</button></div>}</div>
    </div>
  </article>;
});

export default function Home() {
  // The section a link opens (学生档案, 组卷篮) is drawn from the first paint; the server renders the same address.
  const initialView = useSearchParams().get("view");
  const [alevelPageLocale, setAlevelPageLocale] = useState<AlevelPageLocale>("zh");
  const [modules, setModules] = useState<LibraryModule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [activeModuleId, setActiveModuleId] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [basketStructure, setBasketStructure] = useState<BasketStructure>({ sections: [], unassignedIds: [] });
  const selectedIds = useMemo(() => basketIds(basketStructure), [basketStructure]);
  const setSelectedIds = useCallback((update: SetStateAction<string[]>) => setBasketStructure((current) => selectBasketQuestions(current, typeof update === "function" ? update(basketIds(current)) : update)), []);
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const [draftCanSave, setDraftCanSave] = useState(false);
  const [draftStatus, setDraftStatus] = useState("正在读取本机草稿…");
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const activeDraftOwner = useRef<string | null>(null);
  // A student's wrong book is browsed like a library: its question snapshots join the basket pool, so they can be selected and exported.
  const [basketWrongQuestions, setBasketWrongQuestions] = useState<Question[]>([]);
  const [wrongMonth, setWrongMonth] = useState("全部");
  const [wrongUploadOpen, setWrongUploadOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"全部" | QuestionType>("全部");
  const [showSelected, setShowSelected] = useState(initialView === "selected");
  const [expandedAnswers, setExpandedAnswers] = useState<string[]>([]);
  const [entryDraft, setEntryDraft] = useState<Question | null>(null);
  // The question entry is open to add a wrong-book question to the library (it keeps its ID).
  const [entryAddsWrong, setEntryAddsWrong] = useState(false);
  // Questions in students' wrong books that are not in the library, read when a search starts; 题库 search finds them too.
  const [wrongCatalog, setWrongCatalog] = useState<WrongQuestionCatalogItem[] | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<"new" | "manage" | "trash" | null>(null);
  const [trashQuestions, setTrashQuestions] = useState<Array<Question & { deletedAt: number }> | null>(null);
  const [restoringIds, setRestoringIds] = useState<string[]>([]);
  const [categoryName, setCategoryName] = useState("");
  const [categoryParent, setCategoryParent] = useState<string>("");
  const [isExporting, setIsExporting] = useState(false);
  const [paperTitle, setPaperTitle] = useState("专项练习");
  const [includeAnswers, setIncludeAnswers] = useState(true);
  // 快速排版 from the basket takes the whole window. Closing it hands back the title and settings, so the next opening
  // starts where this one stopped; a question's own spacing is kept only while the same questions stay in the same order.
  const [typesetting, setTypesetting] = useState(false);
  const [typesetKept, setTypesetKept] = useState<{ ids: string; settings: TypesetSettings } | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authDialog, setAuthDialog] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authInvite, setAuthInvite] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [moduleDialog, setModuleDialog] = useState<"new" | "manage" | null>(null);
  const [moduleDraft, setModuleDraft] = useState<LibraryModule | null>(null);
  const [moduleName, setModuleName] = useState("");
  const [moduleSubtitle, setModuleSubtitle] = useState("");
  const [draggedModuleId, setDraggedModuleId] = useState("");
  const [confirmDialog, confirm] = useConfirm();
  const deleting = useRef(false);
  const moduleManager = useRef<HTMLDivElement>(null);
  const [showWrongBook, setShowWrongBook] = useState(initialView === "wrong-book");
  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [studentClasses, setStudentClasses] = useState<string[]>([]);
  const [activeClassName, setActiveClassName] = useState<string | null>(null);
  const [classDialog, setClassDialog] = useState<{ previousName?: string; name: string; studentIds: string[] } | null>(null);
  const [classBusy, setClassBusy] = useState(false);
  const [classError, setClassError] = useState("");
  const [classAssigning, setClassAssigning] = useState(false);
  const [studentHomeworkProgress, setStudentHomeworkProgress] = useState<Record<string, HomeworkProgress | null>>({});
  const [activeStudentId, setActiveStudentId] = useState("");
  const [wrongEntries, setWrongEntries] = useState<WrongQuestionEntry[]>([]);
  const [wrongBookLoading, setWrongBookLoading] = useState(initialView === "wrong-book");
  const [archiveTab, setArchiveTab] = useState<ArchiveTab>("homework");
  const [studentDialog, setStudentDialog] = useState(false);
  const [studentDraft, setStudentDraft] = useState<Student | null>(null);
  const [studentName, setStudentName] = useState("");
  const [studentClassName, setStudentClassName] = useState("");
  const [studentNotes, setStudentNotes] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const activeModule = modules.find((item) => item.id === activeModuleId) ?? modules[0] ?? null;
  const isAlevelPage = !showWrongBook && !showSelected && isAlevel9709ModuleName(activeModule?.name);
  const pageLocale: AlevelPageLocale = isAlevelPage ? alevelPageLocale : "zh";
  const pageCopy = ALEVEL_PAGE_COPY[pageLocale];
  const [toastNode, show] = useToast(pageLocale);
  const onNotice = useCallback((text: string, tone: "success" | "error" = "success") => show({ text, tone }), [show]);
  // 机构共用一个题库：登录老师都能录题、改题、建分类；删除只开放给管理员。
  const canManageLibrary = Boolean(authUser);
  const canDelete = authUser?.role === "admin";
  const activeStudent = students.find((item) => item.id === activeStudentId) ?? null;
  const classStudents = activeClassName === null ? [] : students.filter((student) => student.className === activeClassName);
  // Until the first reads come back, the lists say they are loading rather than offering to create the first item.
  const studentsLoading = wrongBookLoading && !students.length;
  const libraryLoading = authLoading && (showSelected || !questions.length);
  const updateHomeworkProgress = useCallback((studentId: string, progress: HomeworkProgress | null) => {
    setStudentHomeworkProgress((current) => current[studentId] === progress ? current : { ...current, [studentId]: progress });
  }, []);

  useEffect(() => {
    if (!showWrongBook || !authUser || !students.length) return;
    let current = true, reading = false;
    // One read brings every student's badge, kept current even when another student or tab is selected; a changed student
    // list (a student added, homework assigned to a class) reads it again at once.
    const refresh = async () => {
      if (document.hidden || reading) return;
      reading = true;
      try {
        const { progress } = await homeworkApi.studentProgress();
        if (current) setStudentHomeworkProgress(progress);
      } catch { /* Keep the last badges until the next refresh. */ }
      finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [showWrongBook, authUser, students]);


  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try { setAlevelPageLocale(window.localStorage.getItem(ALEVEL_PAGE_LOCALE_KEY) === "en" ? "en" : "zh"); } catch { /* 本地存储不可用时保持中文默认值 */ }
      const linked = new URLSearchParams(window.location.search).get("tab");
      let remembered: string | null = null;
      try { remembered = window.localStorage.getItem(ARCHIVE_TAB_KEY); } catch { /* 本地存储不可用时打开“作业” */ }
      const tab = ARCHIVE_TABS.find(([key]) => key === (linked ?? remembered))?.[0];
      if (tab) setArchiveTab(tab);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    const url = new URL(window.location.href);
    if (showWrongBook) {
      url.searchParams.set("view", "wrong-book");
      if (activeClassName !== null) { url.searchParams.set("class", activeClassName); url.searchParams.delete("studentId"); }
      else { url.searchParams.delete("class"); if (activeStudentId) url.searchParams.set("studentId", activeStudentId); else url.searchParams.delete("studentId"); }
      url.searchParams.set("tab", archiveTab);
    } else {
      if (showSelected) url.searchParams.set("view", "selected");
      else if (["selected", "wrong-book"].includes(url.searchParams.get("view") ?? "")) url.searchParams.delete("view");
      url.searchParams.delete("studentId"); url.searchParams.delete("tab"); url.searchParams.delete("class");
    }
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [authLoading, showWrongBook, activeStudentId, activeClassName, archiveTab, showSelected]);

  function chooseAlevelPageLocale(locale: AlevelPageLocale) {
    setAlevelPageLocale(locale);
    try { window.localStorage.setItem(ALEVEL_PAGE_LOCALE_KEY, locale); } catch { /* 本地存储不可用时仍保留本次切换 */ }
  }

  function chooseArchiveTab(tab: ArchiveTab) {
    setArchiveTab(tab);
    try { window.localStorage.setItem(ARCHIVE_TAB_KEY, tab); } catch { /* 本地存储不可用时仍保留本次切换 */ }
  }

  function applyLibrary(data: LibraryData, preserveCategory = true) {
    const sortedModules = [...data.modules].sort((left, right) => left.sortOrder - right.sortOrder);
    setModules(sortedModules);
    setCategories(data.categories.sort((a, b) => a.createdAt - b.createdAt));
    setQuestions(data.questions.sort((a, b) => b.createdAt - a.createdAt));
    const availableIds = new Set([...sortedModules.map((item) => item.id), ...data.categories.map((item) => item.id)]);
    const nextModule = sortedModules.find((item) => item.id === activeModuleId) ?? sortedModules[0] ?? null;
    setActiveModuleId(nextModule?.id ?? "");
    setActiveCategory((current) => preserveCategory && current && availableIds.has(current) ? current : nextModule?.id ?? null);
    if (nextModule && !selectedIds.length) setPaperTitle(`${nextModule.name}专项练习`);
  }

  async function refreshLibrary(preserveCategory = true) {
    const data = await fetchLibrary();
    applyLibrary(data, preserveCategory);
  }

  async function restoreLocalBasket(user: AuthUser, library: Question[]) {
    activeDraftOwner.current = user.id;
    setDraftCanSave(false); setDraftOwner(null); setDraftStatus("正在读取本机草稿…");
    try {
      // An older write from this page must finish before switching back to its owner.
      await saveQueue.current;
      const raw = await basketStorage(user.id, "read");
      if (activeDraftOwner.current !== user.id) return;
      // 学生档案 reads the library after its students, so the open student's wrong questions may be in the pool already;
      // the draft's own snapshots join them rather than replace them.
      if (raw) {
        const { draft, missing } = restoreBasketDraft(raw, library);
        setBasketStructure(draft.structure); setPaperTitle(draft.title); setIncludeAnswers(draft.includeAnswers);
        setBasketWrongQuestions((current) => [...draft.snapshots, ...current.filter((question) => !draft.snapshots.some((item) => item.id === question.id))]); setTypesetKept(draft.typeset);
        if (missing) show({ text: `草稿中 ${missing} 道已失效的题目已移除`, tone: "success" });
      } else {
        setBasketStructure({ sections: [], unassignedIds: [] }); setTypesetKept(null);
      }
      setDraftCanSave(true); setDraftStatus("已保存在本机");
    } catch (error) {
      if (activeDraftOwner.current !== user.id) return;
      setDraftStatus("本机草稿不可用，本次整理尚未保存");
      show({ text: `${error instanceof Error ? error.message : "本机草稿读取失败"}。本次仍可整理和导出，原记录不会被覆盖。`, tone: "error" });
    } finally { if (activeDraftOwner.current === user.id) setDraftOwner(user.id); }
  }

  useEffect(() => {
    if (!authUser || draftOwner !== authUser.id || !draftCanSave) return;
    const owner = authUser.id;
    const draft: BasketDraft = { version: 1, structure: basketStructure, title: paperTitle, includeAnswers, typeset: typesetKept,
      snapshots: basketWrongQuestions.filter((question) => selectedIds.includes(question.id) && !questions.some((item) => item.id === question.id)) };
    // Serialize atomic writes; a slow earlier save cannot overwrite a later edit.
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        if (activeDraftOwner.current === owner) setDraftStatus("正在保存到本机…");
        await basketStorage(owner, "write", draft);
        if (activeDraftOwner.current === owner) setDraftStatus("已保存在本机");
      } catch {
        if (activeDraftOwner.current === owner) {
          setDraftStatus("本机保存失败");
          show({ text: "本机组卷草稿保存失败，本次操作仍有效；请保留页面并及时导出。", tone: "error" });
        }
      }
    });
  }, [authUser, draftOwner, draftCanSave, basketStructure, paperTitle, includeAnswers, typesetKept, basketWrongQuestions, selectedIds, questions, show]);

  useEffect(() => {
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const view = params.get("view");
      // 题库 and 组卷篮 need the whole library, read alongside the account. 学生档案 shows its students first and reads
      // the library (several megabytes, for the basket and a later switch to 题库) only after them.
      const library = view === "wrong-book" ? null : fetchLibrary();
      library?.catch(() => {});
      try {
        const auth = await fetchMe();
        setAuthUser(auth.user);
        if (!auth.user) { setShowWrongBook(false); setShowSelected(false); setWrongBookLoading(false); }
        else if (view === "wrong-book") {
          try { await loadStudents(params.get("studentId") ?? "", params.get("class")); }
          catch (error) { show({ text: error instanceof Error ? error.message : "学生档案读取失败", tone: "error" }); }
          finally { setWrongBookLoading(false); }
        }
        const data = await (library ?? fetchLibrary());
        applyLibrary(data, false);
        if (auth.user) await restoreLocalBasket(auth.user, data.questions);
      } catch { setWrongBookLoading(false); show({ text: "云端题库读取失败，请刷新页面重试", tone: "error" }); }
      finally { setAuthLoading(false); }
    })();
  // The initial URL view is intentionally read once; later switches are handled by page actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const descendantsOf = (id: string) => categoryDescendants(categories, id);
  const moduleById = (id: string | null) => modules.find((item) => item.id === id);
  const pathOf = (id: string) => categoryPath(modules, categories, id);
  const countFor = (id: string) => {
    if (moduleById(id)) return questions.filter((question) => question.moduleId === id).length;
    const ids = descendantsOf(id);
    return questions.filter((question) => ids.includes(question.categoryId)).length;
  };
  const moduleCategories = activeModule ? categories.filter((item) => item.moduleId === activeModule.id) : [];
  const moduleQuestions = activeModule ? questions.filter((item) => item.moduleId === activeModule.id) : [];
  const activeCategoryIds = activeCategory ? descendantsOf(activeCategory) : activeModule ? [activeModule.id, ...moduleCategories.map((item) => item.id)] : [];
  const categoryQuestions = moduleQuestions.filter((item) => activeCategoryIds.includes(item.categoryId));

  function switchExamModule(moduleId: string) {
    const targetModule = modules.find((item) => item.id === moduleId); if (!targetModule) return;
    setActiveModuleId(targetModule.id);
    setActiveCategory(targetModule.id);
    setMapQuestionId("");
    if (!selectedIds.length) setPaperTitle(`${targetModule.name}专项练习`);
    setTypeFilter("全部");
    setQuery("");
    setShowSelected(false);
    setShowWrongBook(false);
  }

  const basketBusy = isExporting || Boolean(authUser && draftOwner !== authUser.id);
  const basketPool = useMemo(() => [...basketWrongQuestions, ...questions], [questions, basketWrongQuestions]);
  const selectedQuestions = orderedBasketQuestions(basketPool, selectedIds);
  const paperSections = useMemo(() => basketSections(basketStructure, basketPool), [basketStructure, basketPool]);
  const sectionChoices = useMemo(() => paperSections.map((section) => ({ id: section.id, title: section.id ? section.title : "未分组" })), [paperSections]);
  const byCode = query.trim() ? questions.find((item) => item.code === query.trim()) : undefined;
  const filteredQuestions = useMemo(() => {
    if (showSelected) return orderedBasketQuestions(basketPool, selectedIds);
    const keyword = query.trim().toLowerCase();
    if (byCode) return [byCode];
    let result = questions;
    if (activeCategory) { const allowed = descendantsOf(activeCategory); result = result.filter((item) => allowed.includes(item.categoryId)); }
    if (typeFilter !== "全部") result = result.filter((item) => item.type === typeFilter);
    if (keyword) result = result.filter((item) => questionMatchesKeyword(item, keyword, pathOf(item.categoryId)));
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions, basketPool, categories, activeCategory, showSelected, typeFilter, query, selectedIds, byCode]);
  // A search also finds questions that are only in students' wrong books, by their ID or their text.
  const searchingWrong = Boolean(authUser) && !showSelected && !showWrongBook && Boolean(query.trim());
  useEffect(() => {
    if (!searchingWrong || wrongCatalog) return;
    let current = true;
    fetchWrongQuestionCatalog().then(({ items }) => { if (current) setWrongCatalog(items); }).catch(() => { if (current) setWrongCatalog([]); });
    return () => { current = false; };
  }, [searchingWrong, wrongCatalog]);
  const wrongMatches = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!searchingWrong || !wrongCatalog) return [];
    return wrongCatalog.filter((item) => item.question.code === query.trim() || questionMatchesKeyword(item.question, keyword, `错题本 ${item.students.map((student) => student.name).join(" ")}`));
  }, [searchingWrong, wrongCatalog, query]);
  // A new filter starts again from the top (8 cards, then 40); the end marker loads the next 40 while it is still well below the screen.
  const listKey = `${activeModuleId}|${activeCategory}|${typeFilter}|${query}|${showSelected}`;
  const [listPaging, setListPaging] = useState({ key: "", count: LIBRARY_PAGE });
  const [locatingQuestion, setLocatingQuestion] = useState<string | null>(null);
  const visibleCount = listPaging.key === listKey ? listPaging.count : LIBRARY_FIRST;
  useEffect(() => {
    if (listPaging.key === listKey) return;
    // After the frame that shows the first cards, not in the same one.
    let timer = 0;
    const frame = requestAnimationFrame(() => { timer = window.setTimeout(() => setListPaging((current) => current.key === listKey ? current : { key: listKey, count: LIBRARY_PAGE })); });
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [listKey, listPaging.key]);
  // The basket question shown on the knowledge map: the one last clicked in the outline or the list, else the first.
  const [activeBasketId, setActiveBasketId] = useState("");
  const activeBasketQuestion = selectedQuestions.find((question) => question.id === activeBasketId) ?? selectedQuestions[0] ?? null;
  // 题库 · 右栏知识图谱 shows the question the pointer rested on, else the category picked in the tree, and lights
  // the tree's categories that hold what it shows.
  const showKnowledgeMap = Boolean(authUser && activeModule) && !showSelected && !showWrongBook && !isAlevelPage;
  const [mapQuestionId, setMapQuestionId] = useState("");
  // Folded or open is remembered per browser; the panel is only drawn in the browser, so reading it here is safe.
  const [mapOpen, setMapOpen] = useState(() => { try { return window.localStorage.getItem(KNOWLEDGE_MAP_KEY) !== "closed"; } catch { return true; } });
  // Folding slides the panel out before it leaves, so it stays mounted (frozen on what it showed) until the column has narrowed.
  const [mapMounted, setMapMounted] = useState(mapOpen);
  const mapFoldTimer = useRef(0);
  const chooseMapOpen = useCallback((open: boolean) => {
    setMapOpen(open);
    window.clearTimeout(mapFoldTimer.current);
    if (open) setMapMounted(true);
    else mapFoldTimer.current = window.setTimeout(() => setMapMounted(false), 520);
    try { window.localStorage.setItem(KNOWLEDGE_MAP_KEY, open ? "open" : "closed"); } catch { /* 本地存储不可用时仍保留本次切换 */ }
  }, []);
  const collapseMap = useCallback(() => chooseMapOpen(false), [chooseMapOpen]);
  const expandMap = useCallback(() => chooseMapOpen(true), [chooseMapOpen]);
  const [treeLight, setTreeLight] = useState<TreeLight | null>(null);
  const hoverTimer = useRef(0);
  const mapQuestion = showKnowledgeMap && mapMounted && mapQuestionId ? filteredQuestions.find((question) => question.id === mapQuestionId) ?? null : null;
  const knowledgeMapFocus = useMemo<KnowledgeMapFocus | null>(() => {
    if (!showKnowledgeMap || !mapMounted || !activeModule) return null;
    if (mapQuestion) return { kind: "question", question: mapQuestion, number: filteredQuestions.indexOf(mapQuestion) + 1 };
    const id = activeCategory ?? activeModule.id;
    return { kind: "category", id, name: categories.find((item) => item.id === id)?.name ?? activeModule.name };
  }, [activeCategory, activeModule, categories, filteredQuestions, mapMounted, mapQuestion, showKnowledgeMap]);
  const locateBasketQuestion = (id: string) => {
    const index = selectedIds.indexOf(id);
    if (index < 0) return;
    setActiveBasketId(id);
    setListPaging((current) => ({ key: listKey, count: Math.max(current.key === listKey ? current.count : LIBRARY_PAGE, index + 1) }));
    setLocatingQuestion(id);
  };
  useEffect(() => {
    if (!locatingQuestion || !showSelected || typesetting) return;
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(`basket-question-${locatingQuestion}`);
      if (card) { card.scrollIntoView({ block: "start" }); card.focus({ preventScroll: true }); setLocatingQuestion(null); }
    });
    return () => cancelAnimationFrame(frame);
  }, [locatingQuestion, showSelected, typesetting, visibleCount]);
  const listEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const end = listEndRef.current;
    if (!end) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setListPaging({ key: listKey, count: visibleCount + LIBRARY_PAGE });
    }, { rootMargin: "0px 0px 1600px 0px" });
    observer.observe(end);
    return () => observer.disconnect();
  }, [listKey, visibleCount, filteredQuestions.length, typesetting]);

  const activeName = activeCategory ? pathOf(activeCategory) : activeModule?.name || pageCopy.publicLibrary;
  const activeWrongEntries = wrongEntries.filter(entry => entry.archivedAt == null);
  const historicalWrongEntries = wrongEntries.filter(entry => entry.archivedAt != null);
  const filteredWrongEntries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return wrongEntries.filter(entry => entry.archivedAt == null);
    return wrongEntries.filter(entry => entry.archivedAt == null).filter((entry) => `${entry.question.code ?? ""} ${entry.question.stem} ${entry.question.answer} ${entry.question.analysis} ${entry.question.source} ${entry.sourcePath}`.toLowerCase().includes(keyword));
  }, [query, wrongEntries]);
  // Wrong questions are filed by the month they were last got wrong, newest month first.
  const wrongMonthOf = (entry: WrongQuestionEntry) => { const date = new Date(entry.lastWrongAt); return `${date.getFullYear()}年${date.getMonth() + 1}月`; };
  const wrongMonths = [...new Set([...activeWrongEntries].sort((a, b) => b.lastWrongAt - a.lastWrongAt).map(wrongMonthOf))];
  const activeWrongMonth = wrongMonths.includes(wrongMonth) ? wrongMonth : "全部";
  const visibleWrongMonths = wrongMonths.filter((month) => activeWrongMonth === "全部" || month === activeWrongMonth)
    .map((month) => ({ month, entries: filteredWrongEntries.filter((entry) => wrongMonthOf(entry) === month) })).filter((group) => group.entries.length);
  const selectedWrongEntries = activeWrongEntries.filter((entry) => selectedIds.includes(entry.question.id));
  const selectableIds = showWrongBook ? visibleWrongMonths.flatMap((group) => group.entries.map((entry) => entry.question.id)) : filteredQuestions.map((item) => item.id);

  const selectedHere = selectedQuestions.filter(question => showWrongBook ? selectedWrongEntries.some(entry => entry.question.id === question.id) : activeCategoryIds.includes(question.categoryId)).length;
  const allFilteredSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.includes(id));

  function showWrongEntries(entries: WrongQuestionEntry[]) {
    setWrongEntries(entries);
    const snapshots = entries.filter((entry) => entry.archivedAt == null).map((entry) => entry.question);
    setBasketWrongQuestions((current) => [...current.filter((item) => !snapshots.some((question) => question.id === item.id)), ...snapshots]);
  }

  const requireLogin = () => { if (authUser) { if (draftOwner !== authUser.id) { show({ text: "正在读取本机组卷草稿，请稍候", tone: "success" }); return false; } return true; } setAuthMode("login"); setAuthDialog(true); setAuthError("请先登录后再使用这项功能"); return false; };
  function openLibrary() {
    setShowSelected(false); setShowWrongBook(false);
  }

  async function loadStudents(preferredStudentId = activeStudentId, preferredClassName?: string | null) {
    const result = await fetchStudents();
    setStudents(result.students);
    setStudentClasses(result.classes);
    setActiveClassName((current) => { const name = preferredClassName ?? current; return name !== null && result.classes.includes(name) ? name : null; });
    const nextId = result.students.some((item) => item.id === preferredStudentId) ? preferredStudentId : result.students[0]?.id ?? "";
    setActiveStudentId(nextId);
    if (nextId) {
      const wrong = await fetchWrongQuestions(nextId);
      showWrongEntries(wrong.entries);
    } else showWrongEntries([]);
    return result.students;
  }

  async function openWrongBook() {
    if (!requireLogin()) return;
    setShowWrongBook(true); setShowSelected(false); setQuery(""); setWrongMonth("全部"); setWrongBookLoading(true);
    try { await loadStudents(); }
    catch (error) { show({ text: error instanceof Error ? error.message : "错题本读取失败", tone: "error" }); }
    finally { setWrongBookLoading(false); }
  }

  async function selectStudent(id: string) {
    setActiveClassName(null);
    setActiveStudentId(id); setWrongBookLoading(true); setQuery(""); setWrongMonth("全部");
    try { showWrongEntries((await fetchWrongQuestions(id)).entries); }
    catch (error) { show({ text: error instanceof Error ? error.message : "错题记录读取失败", tone: "error" }); }
    finally { setWrongBookLoading(false); }
  }

  function openStudentDialog(student?: Student) {
    setStudentDraft(student ?? null); setStudentName(student?.name ?? ""); setStudentClassName(student?.className ?? activeClassName ?? ""); setStudentNotes(student?.notes ?? ""); setStudentDialog(true);
  }

  async function saveStudent() {
    if (!studentName.trim()) { show({ text: "请填写学生姓名或昵称", tone: "error" }); return; }
    try {
      const payload = { name: studentName, className: studentClassName, notes: studentNotes };
      const result = studentDraft
        ? await updateStudentProfile({ ...studentDraft, ...payload })
        : await createStudentProfile(payload);
      setStudentDialog(false); await loadStudents(result.student.id); setActiveClassName(null);
      show({ text: studentDraft ? "学生档案已更新" : `已创建学生档案：${result.student.name}`, tone: "success" });
    } catch (error) { show({ text: error instanceof Error ? error.message : "学生档案保存失败", tone: "error" }); }
  }

  function openClassDialog(name?: string) {
    setClassError("");
    setClassDialog({ previousName: name, name: name ?? "", studentIds: name ? students.filter((student) => student.className === name).map((student) => student.id) : [] });
  }

  async function saveClass() {
    if (!classDialog || classBusy) return;
    setClassBusy(true); setClassError("");
    try {
      const result = await saveStudentClass(classDialog.name, classDialog.studentIds, classDialog.previousName);
      await loadStudents(); setActiveClassName(result.name); setClassDialog(null);
      show({ text: classDialog.previousName === undefined ? `已创建班级：${result.name}` : "班级已保存", tone: "success" });
    } catch (error) { setClassError(error instanceof Error ? error.message : "班级保存失败"); }
    finally { setClassBusy(false); }
  }

  async function removeClass(name: string) {
    if (classBusy || !await confirm({ title: `删除班级「${name}」`, body: "仅删除班级分组。学生会保留为独立个体，作业、批改和错题记录全部保留。", confirmLabel: "删除班级", danger: true })) return;
    setClassBusy(true);
    try {
      await deleteStudentClass(name); await loadStudents(); setActiveClassName(null);
      show({ text: "班级已删除，学生档案和作业已保留", tone: "success" });
    } catch (error) { show({ text: error instanceof Error ? error.message : "班级删除失败", tone: "error" }); }
    finally { setClassBusy(false); }
  }

  async function removeStudent(student: StudentSummary) {
    if (deleting.current) return;
    deleting.current = true;
    try {
      if (!await confirm({ title: `删除学生档案「${student.name}」`,
        items: ["学生讲义", "作业与批改记录，包括上传的照片", `错题本（${student.wrongCount} 道）`, "课后反馈和学情报告"],
        body: "这些内容会一起永久删除，无法恢复。", typeToConfirm: student.name, confirmLabel: "永久删除", danger: true })) return;
      const index = students.findIndex((item) => item.id === student.id);
      const nextId = activeStudentId === student.id ? students[index + 1]?.id ?? students[index - 1]?.id ?? "" : activeStudentId;
      await deleteStudentProfile(student.id);
      await loadStudents(nextId);
      show({ text: `已删除学生档案：${student.name}`, tone: "success" });
    } catch (error) { show({ text: error instanceof Error ? error.message : "学生档案删除失败", tone: "error" }); }
    finally { deleting.current = false; }
  }

  const toggleSelected = (id: string) => { if (!requireLogin()) return; setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); };
  const toggleAllFiltered = () => {
    if (!requireLogin()) return;
    setSelectedIds((current) => allFilteredSelected ? current.filter((id) => !selectableIds.includes(id)) : [...current, ...selectableIds.filter((id) => !current.includes(id))]);
  };
  const openNewQuestion = () => { if (!requireLogin() || !canManageLibrary) return; if (!activeModule) { setModuleDialog("new"); return; } setEntryDraft(newQuestionDraft(activeModule, activeCategory ?? activeModule.id)); };
  const addWrongToLibrary = async (item: WrongQuestionCatalogItem) => {
    if (!requireLogin() || !canManageLibrary) return;
    if (!activeModule) { setModuleDialog("new"); return; }
    try {
      // The student's photographed page is evidence of the mistake, not part of the question.
      const question: Question = { ...item.question };
      delete question.code; delete question.canEdit; delete question.originalImage;
      const draft = await inlineHomeworkImages(question) as Question;
      setEntryAddsWrong(true);
      setEntryDraft(editableQuestionDraft({ ...draft, moduleId: activeModule.id, categoryId: activeCategory ?? activeModule.id, createdAt: Date.now(), updatedAt: Date.now() }, activeModule));
    } catch (error) { show({ text: error instanceof Error ? error.message : "错题读取失败", tone: "error" }); }
  };
  const openEditQuestion = (question: Question) => { if (!requireLogin() || !question.canEdit) { show({ text: "当前题库为只读", tone: "error" }); return; } const questionModule = modules.find((item) => item.id === question.moduleId); if (questionModule && questionModule.id !== activeModuleId) { setActiveModuleId(questionModule.id); setPaperTitle(`${questionModule.name}专项练习`); setActiveCategory(question.categoryId); } setEntryDraft(editableQuestionDraft(question, questionModule)); };

  async function submitAuth() {
    setAuthSubmitting(true); setAuthError("");
    try {
      const result = authMode === "register" ? await register(authEmail, authPassword, authInvite) : await login(authEmail, authPassword);
      setAuthUser(result.user); setAuthDialog(false); setAuthPassword(""); setAuthInvite("");
      const data = await fetchLibrary(); applyLibrary(data, true); await restoreLocalBasket(result.user, data.questions);
      show({ text: authMode === "register" ? "注册成功，已登录云端题库" : "登录成功", tone: "success" });
    } catch (error) { setAuthError(error instanceof Error ? error.message : "操作失败，请重试"); }
    finally { setAuthSubmitting(false); }
  }

  async function signOut() {
    try { await logout(); activeDraftOwner.current = null; setDraftOwner(null); setDraftCanSave(false); setAuthUser(null); setBasketStructure({ sections: [], unassignedIds: [] }); setBasketWrongQuestions([]); setTypesetKept(null); setIncludeAnswers(true); setPaperTitle("专项练习"); setShowSelected(false); setShowWrongBook(false); setStudents([]); setStudentClasses([]); setActiveClassName(null); setWrongEntries([]); await refreshLibrary(false); show({ text: "已退出登录，当前为访客浏览", tone: "success" }); }
    catch (error) { show({ text: error instanceof Error ? error.message : "退出失败", tone: "error" }); }
  }

  async function deleteQuestion(question: Question) {
    try {
      await deleteCloudQuestion(question.id);
      setQuestions(current => current.filter(item => item.id !== question.id));
      setSelectedIds(current => current.filter(id => id !== question.id));
      show({ text: pageLocale === "en" ? "Deleted 1 question. Available in the recycle bin." : "已删除 1 道题，可在回收站找回", tone: "success", action: { label: pageCopy.undo, run: () => restoreQuestions([question.id]) } });
    } catch (error) { show({ text: error instanceof Error ? error.message : "删除失败", tone: "error", action: { label: pageCopy.retry, run: () => deleteQuestion(question) } }); }
  }

  // Cards keep one stable set of actions; each call reaches this render's handlers, so a card need not re-render for them.
  const cardHandlers = useRef({ toggleSelected, openEditQuestion, deleteQuestion });
  useEffect(() => { cardHandlers.current = { toggleSelected, openEditQuestion, deleteQuestion }; });
  const cardActions = useMemo<CardActions>(() => ({
    toggleSelected: (id) => cardHandlers.current.toggleSelected(id),
    toggleAnswer: (id) => setExpandedAnswers((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]),
    edit: (question) => cardHandlers.current.openEditQuestion(question),
    remove: (question) => { void cardHandlers.current.deleteQuestion(question); },
    move: (id, direction) => setBasketStructure((current) => {
      const section = current.sections.find((item) => item.questionIds.includes(id));
      return section ? { ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, questionIds: moveBasketQuestion(item.questionIds, id, direction) } : item) }
        : { ...current, unassignedIds: moveBasketQuestion(current.unassignedIds, id, direction) };
    }),
    drop: (id) => setSelectedIds((ids) => ids.filter((item) => item !== id)),
    activate: setActiveBasketId,
    // A short rest before switching, so the pointer crossing the list does not spin the graph through every card.
    hover: (id) => { window.clearTimeout(hoverTimer.current); if (id) hoverTimer.current = window.setTimeout(() => setMapQuestionId(id), 220); },
    place: (id, sectionId) => setBasketStructure((current) => placeBasketQuestion(current, id, sectionId)),
  }), [setSelectedIds]);

  async function deleteWrongEntries(entries: WrongQuestionEntry[]) {
    if (!entries.length) return;
    const results = await Promise.allSettled(entries.map(entry => deleteWrongQuestion(entry.studentId, entry.id)));
    const removed = entries.filter((_entry, index) => results[index].status === "fulfilled");
    const failure = results.find(result => result.status === "rejected");
    const ids = removed.map(entry => entry.question.id);
    setSelectedIds(current => current.filter(id => !ids.includes(id)));
    try {
      const current = new URLSearchParams(window.location.search).get("studentId");
      if (current) await loadStudents(current); else setStudents((await fetchStudents()).students);
      show({ text: failure ? `已删除 ${removed.length} 道错题，${entries.length - removed.length} 道未删除，请重试` : `已删除 ${removed.length} 道错题，可在历史记录找回`, tone: failure ? "error" : "success",
        action: removed.length ? { label: "撤销", run: () => restoreWrongEntries(removed) } : { label: "重试", run: () => deleteWrongEntries(entries) } });
    } catch (error) { show({ text: `已删除 ${removed.length} 道错题，但列表读取失败：${error instanceof Error ? error.message : "请重试"}`, tone: "error", action: removed.length ? { label: "撤销", run: () => restoreWrongEntries(removed) } : { label: "重试", run: () => deleteWrongEntries(entries) } }); }
  }

  async function restoreWrongEntries(entries: WrongQuestionEntry[], restored = 0) {
    const results = await Promise.allSettled(entries.map(entry => restoreWrongQuestion(entry.studentId, entry.id)));
    const recovered = entries.filter((_entry, index) => results[index].status === "fulfilled");
    const failed = entries.filter((_entry, index) => results[index].status === "rejected");
    const total = restored + recovered.length;
    try {
      const current = new URLSearchParams(window.location.search).get("studentId");
      if (current) await loadStudents(current); else setStudents((await fetchStudents()).students);
      show({ text: failed.length ? `已恢复 ${total} 道错题，${failed.length} 道未恢复，请重试` : `已恢复 ${total} 道错题`, tone: failed.length ? "error" : "success",
        ...(failed.length ? { action: { label: "重试", run: () => restoreWrongEntries(failed, total) } } : {}) });
    } catch (error) { show({ text: `已恢复 ${total} 道错题，但列表读取失败：${error instanceof Error ? error.message : "请重试"}`, tone: "error", action: { label: "重试", run: () => restoreWrongEntries(failed, total) } }); }
  }

  async function deleteSelectedQuestions() {
    const ids = selectedIds.filter(id => questions.some(item => item.id === id));
    if (!ids.length) return;
    const editableIds = ids.filter(id => questions.find(item => item.id === id)?.canEdit);
    if (!editableIds.length) { show({ text: "所选题目中没有你可以删除的内容", tone: "error" }); return; }
    const results = await Promise.allSettled(editableIds.map(id => deleteCloudQuestion(id)));
    const removed = editableIds.filter((_id, index) => results[index].status === "fulfilled");
    const failure = results.find(result => result.status === "rejected");
    setQuestions(current => current.filter(item => !removed.includes(item.id)));
    setExpandedAnswers(current => current.filter(id => !removed.includes(id)));
    setSelectedIds(current => current.filter(id => !removed.includes(id)));
    show({ text: pageLocale === "en" ? failure ? `Deleted ${alevelQuestionCount(removed.length, pageLocale)}; ${alevelQuestionCount(editableIds.length - removed.length, pageLocale)} could not be deleted. Please retry.` : `Deleted ${alevelQuestionCount(removed.length, pageLocale)}. Available in the recycle bin.` : failure ? `已删除 ${removed.length} 道题，${editableIds.length - removed.length} 道未删除，请重试` : `已删除 ${removed.length} 道题，可在回收站找回`, tone: failure ? "error" : "success",
      action: removed.length ? { label: pageCopy.undo, run: () => restoreQuestions(removed) } : { label: pageCopy.retry, run: deleteSelectedQuestions } });
  }

  async function createCategory() {
    if (!categoryName.trim() || !activeModule) { show({ text: "请填写分类名称", tone: "error" }); return; }
    const category: Category = { id: uid("cat"), name: categoryName.trim(), moduleId: activeModule.id, parentId: categoryParent || activeModule.id, createdAt: currentTimestamp() };
    try { const result = await createCloudCategory(category); setCategories((current) => [...current, result.category]); setCategoryName(""); setCategoryDialog(null); setActiveCategory(result.category.id); show({ text: "分类已创建", tone: "success" }); }
    catch (error) { show({ text: error instanceof Error ? error.message : "分类创建失败", tone: "error" }); }
  }

  async function openTrash() {
    setCategoryDialog("trash"); setTrashQuestions(null);
    try { setTrashQuestions((await fetchDeletedQuestions()).questions); }
    catch (error) { show({ text: error instanceof Error ? error.message : "回收站读取失败", tone: "error" }); }
  }

  async function restoreQuestions(ids: string[], restored = 0) {
    const results = await Promise.allSettled(ids.map(id => restoreCloudQuestion(id)));
    const recovered = ids.filter((_id, index) => results[index].status === "fulfilled");
    const failed = ids.filter((_id, index) => results[index].status === "rejected");
    const total = restored + recovered.length;
    setTrashQuestions(current => current?.filter(item => !recovered.includes(item.id)) ?? null);
    try {
      const data = await fetchLibrary();
      setQuestions(data.questions.sort((a, b) => b.createdAt - a.createdAt));
      show({ text: pageLocale === "en" ? failed.length ? `Restored ${alevelQuestionCount(total, pageLocale)}; ${alevelQuestionCount(failed.length, pageLocale)} could not be restored. Please retry.` : `Restored ${alevelQuestionCount(total, pageLocale)}.` : failed.length ? `已恢复 ${total} 道题，${failed.length} 道未恢复，请重试` : `已恢复 ${total} 道题`, tone: failed.length ? "error" : "success",
        ...(failed.length ? { action: { label: pageCopy.retry, run: () => restoreQuestions(failed, total) } } : {}) });
    } catch (error) { show({ text: pageLocale === "en" ? `Restored ${alevelQuestionCount(total, pageLocale)}, but the list could not be refreshed. ${error instanceof Error ? error.message : "Please retry."}` : `已恢复 ${total} 道题，但列表读取失败：${error instanceof Error ? error.message : "请重试"}`, tone: "error", action: { label: pageCopy.retry, run: () => restoreQuestions(failed, total) } }); }
  }

  // A question can be restored once; a second click while the first request runs would come back 404 and report a failure.
  async function restoreTrashQuestion(id: string) {
    if (restoringIds.includes(id)) return;
    setRestoringIds(current => [...current, id]);
    try { await restoreQuestions([id]); }
    finally { setRestoringIds(current => current.filter(item => item !== id)); }
  }

  async function deleteCategory(category: Category) {
    const categoryIds = descendantsOf(category.id); const questionIds = questions.filter((item) => categoryIds.includes(item.categoryId)).map((item) => item.id);
    if (!await confirm({ title: `删除分类「${category.name}」`, body: "分类与子分类无法恢复，题目可从回收站找回。", items: [`${categoryIds.length} 个分类（含当前分类）`, `${questionIds.length} 道题移入回收站`], confirmLabel: "删除分类", danger: true })) return;
    try { await deleteCloudCategory(category.id); setCategories((current) => current.filter((item) => !categoryIds.includes(item.id))); setQuestions((current) => current.filter((item) => !questionIds.includes(item.id))); setSelectedIds((current) => current.filter((id) => !questionIds.includes(id))); setActiveCategory(activeModule?.id ?? null); show({ text: "分类已删除", tone: "success" }); }
    catch (error) { show({ text: error instanceof Error ? error.message : "分类删除失败", tone: "error" }); }
  }

  function exportBackup() {
    const data: LibraryData = { scope: "public", modules, categories, questions };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `MathPilot题库备份-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); show({ text: "备份文件已导出", tone: "success" });
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    try { const data = JSON.parse(await file.text()) as LibraryData; if (!Array.isArray(data.categories) || !Array.isArray(data.questions)) throw new Error("bad shape"); if (!await confirm({ title: "导入备份到题库", body: "将追加到当前题库，不覆盖已有内容；导入后不能一键撤销。", items: [`${Array.isArray(data.modules) ? data.modules.length : 0} 个模块`, `${data.categories.length} 个分类`, `${data.questions.length} 道题`], confirmLabel: "导入备份" })) return; const result = await importCloudLibrary(data); await refreshLibrary(false); setSelectedIds([]); setCategoryDialog(null); show({ text: `已迁移 ${result.imported} 道题到当前题库`, tone: "success" }); } catch (error) { show({ text: error instanceof Error ? error.message : "无法识别这个备份文件", tone: "error" }); } finally { event.target.value = ""; }
  }

  async function generateWord() {
    if (!selectedQuestions.length || basketBusy) return;
    setIsExporting(true);
    try {
      await authorizeDownload(selectedQuestions.map((question) => question.id));
      const title = paperTitle.trim() || "练习题";
      const sections = paperSections.filter((section) => section.questions.length).map((section) => ({ heading: section.heading || `试题（共${selectedQuestions.length}题）`, questions: section.questions }));
      downloadWordBlob(basketStructure.sections.length ? await buildWordBlob({ title, sections, answers: includeAnswers ? "end" : "none", answerHeadings: true }) : await buildQuestionsWordBlob(selectedQuestions, title, includeAnswers, "basket"), `${title}.docx`);
      show({ text: "Word 练习已生成", tone: "success" });
    }
    catch (error) { show({ text: error instanceof Error ? error.message : "下载失败", tone: "error" }); }
    finally { setIsExporting(false); }
  }

  async function openTypeset() {
    if (!selectedQuestions.length || basketBusy) return;
    try { await authorizeDownload(selectedQuestions.map((question) => question.id)); setTypesetting(true); }
    catch (error) { show({ text: error instanceof Error ? error.message : "无法排版所选题目", tone: "error" }); }
  }

  async function classifyBasket() {
    if (basketBusy || !selectedQuestions.length) return;
    if (basketStructure.sections.length && !await confirm({ title: "按题型重新分类", body: "现有大标题及题目归属会被替换，所有题目都会保留，组内按当前顺序排列。", confirmLabel: "重新分类" })) return;
    setBasketStructure((current) => groupBasketByType(current, basketPool, () => uid("section")));
  }

  function openNewModule() {
    if (!requireLogin() || !canManageLibrary) return;
    setModuleDraft(null); setModuleName(""); setModuleSubtitle(""); setModuleDialog("new");
  }

  function openModuleEditor(module: LibraryModule) {
    setModuleDraft(module); setModuleName(module.name); setModuleSubtitle(module.subtitle); setModuleDialog("new");
  }

  async function saveModule() {
    if (!moduleName.trim()) { show({ text: "请填写模块名称", tone: "error" }); return; }
    try {
      if (moduleDraft) {
        const result = await updateCloudModule({ ...moduleDraft, name: moduleName.trim(), subtitle: moduleSubtitle.trim() });
        setModules((current) => current.map((item) => item.id === result.module.id ? result.module : item));
        if (activeModuleId === result.module.id) setPaperTitle(`${result.module.name}专项练习`);
        show({ text: "模块已更新", tone: "success" });
      } else {
        const result = await createCloudModule({ name: moduleName.trim(), subtitle: moduleSubtitle.trim() });
        setModules((current) => [...current, result.module]); setActiveModuleId(result.module.id); setActiveCategory(result.module.id); setPaperTitle(`${result.module.name}专项练习`);
        show({ text: "模块已创建", tone: "success" });
      }
      setModuleDialog(null); setModuleDraft(null); setModuleName(""); setModuleSubtitle("");
    } catch (error) { show({ text: error instanceof Error ? error.message : "模块保存失败", tone: "error" }); }
  }

  async function moveModule(id: string, direction: -1 | 1) {
    const index = modules.findIndex((item) => item.id === id); const target = index + direction;
    if (index < 0 || target < 0 || target >= modules.length) return;
    const next = [...modules]; [next[index], next[target]] = [next[target], next[index]];
    const ordered = next.map((item, sortOrder) => ({ ...item, sortOrder }));
    setModules(ordered);
    try { await reorderCloudModules(ordered.map((item) => item.id)); }
    catch (error) { await refreshLibrary(true); show({ text: error instanceof Error ? error.message : "模块排序失败", tone: "error" }); }
  }

  async function dropModule(targetId: string) {
    if (!draggedModuleId || draggedModuleId === targetId) { setDraggedModuleId(""); return; }
    const source = modules.find((item) => item.id === draggedModuleId); const targetIndex = modules.findIndex((item) => item.id === targetId);
    if (!source || targetIndex < 0) return;
    const next = modules.filter((item) => item.id !== draggedModuleId); next.splice(targetIndex, 0, source);
    const ordered = next.map((item, sortOrder) => ({ ...item, sortOrder })); setModules(ordered); setDraggedModuleId("");
    try { await reorderCloudModules(ordered.map((item) => item.id)); }
    catch (error) { await refreshLibrary(true); show({ text: error instanceof Error ? error.message : "模块排序失败", tone: "error" }); }
  }

  async function removeModule(module: LibraryModule) {
    if (deleting.current) return;
    deleting.current = true;
    try {
      if (!await confirm({ title: `删除模块「${module.name}」`,
        items: [`${questions.filter((item) => item.moduleId === module.id).length} 道题`, `${categories.filter((item) => item.moduleId === module.id).length} 个分类`],
        body: "模块及其内容会一起永久删除，无法恢复。", typeToConfirm: module.name, confirmLabel: "确认删除", danger: true })) return;
      await deleteCloudModule(module.id, module.name);
      const removedId = module.id;
      const next = modules.filter((item) => item.id !== removedId);
      const removedQuestions = questions.filter((item) => item.moduleId === removedId).map((item) => item.id);
      setModules(next); setCategories((current) => current.filter((item) => item.moduleId !== removedId)); setQuestions((current) => current.filter((item) => item.moduleId !== removedId));
      setSelectedIds((current) => current.filter((id) => !removedQuestions.includes(id)));
      setModuleDialog(null);
      setActiveModuleId(next[0]?.id ?? ""); setActiveCategory(next[0]?.id ?? null); if (next[0]) setPaperTitle(`${next[0].name}专项练习`);
      show({ text: "模块及其内容已删除", tone: "success" });
      requestAnimationFrame(() => moduleManager.current?.querySelector<HTMLButtonElement>(".more-toggle")?.focus());
    } catch (error) { show({ text: error instanceof Error ? error.message : "模块删除失败", tone: "error" }); }
    finally { deleting.current = false; }
  }

  const typesetIds = useMemo(() => orderedBasketQuestions(basketPool, selectedIds).map((question) => question.id).join(","), [basketPool, selectedIds]);
  const keepTypeset = useCallback((title: string, settings: TypesetSettings) => {
    setPaperTitle(title); setIncludeAnswers(settings.answers !== "none"); setTypesetKept({ ids: typesetIds, settings });
  }, [typesetIds]);
  if (typesetting) return <>{toastNode}<Suspense fallback={<div className="wrong-book-loading"><i></i><span>正在打开快速排版…</span></div>}><Typesetter basket={{
    questions: selectedQuestions, title: paperTitle,
    groups: basketStructure.sections.length ? paperSections.filter((section) => section.questions.length).map((section) => ({ title: section.heading, size: section.questions.length })) : undefined,
    groupMode: "sections",
    settings: typesetKept ? { ...typesetKept.settings, ownRoom: typesetKept.ids === typesetIds ? typesetKept.settings.ownRoom : {} } : { answers: includeAnswers ? "end" : "none" },
    onChange: keepTypeset,
    onClose: (title, settings) => { keepTypeset(title, settings); setTypesetting(false); },
  }} /></Suspense></>;

  return (
    <main className={`app-shell ${isAlevelPage ? `alevel-page locale-${pageLocale}` : ""}`.trim()}>
      <SiteHeader active={showWrongBook ? "students" : showSelected ? "basket" : "library"} user={authUser} loading={authLoading && !authUser} locale={pageLocale} basketCount={selectedIds.length}
        title={showWrongBook && (activeClassName || activeStudent) ? `${activeClassName ?? activeStudent?.name} · ${pageCopy.navStudents}` : undefined} onSignOut={signOut}
        onSelect={(section) => { if (section === "library") openLibrary(); else if (section === "students") void openWrongBook(); else { setShowWrongBook(false); setShowSelected(true); } }}
        actions={authUser ? canManageLibrary && !showWrongBook && !showSelected && <button className="primary-button" onClick={openNewQuestion} disabled={!activeModule}><span>＋</span> {pageCopy.newQuestion}</button> : <button className="account-button" onClick={() => { setAuthMode("login"); setAuthError(""); setAuthDialog(true); }}>{pageCopy.loginRegister}</button>} />

      <section className={`workspace ${showSelected && !showWrongBook ? "basket-workspace" : ""}`}>
        {(!showSelected || showWrongBook) && <aside className="sidebar">
          {showWrongBook ? <>
            <div className="sidebar-heading"><span className="eyebrow">班级{studentsLoading ? "" : ` · ${studentClasses.length}`}</span><button className="icon-button" aria-label="新建班级" title="新建班级" onClick={() => openClassDialog()}>＋</button></div>
            <div className="class-list" aria-label="班级">{studentClasses.map((name) => <button key={name} className={`class-card${activeClassName === name ? " active" : ""}`} onClick={() => setActiveClassName(name)}><span>▦</span><b>{name}</b><small>{students.filter((student) => student.className === name).length} 人</small></button>)}</div>
            <div className="sidebar-heading"><span className="eyebrow">学生{studentsLoading ? "" : ` · ${students.length}`}</span><button className="icon-button" aria-label="新建学生档案" title="新建学生档案" onClick={() => openStudentDialog()}>＋</button></div>
            <div className="student-list">{students.length ? students.map((student) => <button key={student.id} className={`student-card ${activeClassName === null && student.id === activeStudentId ? "active" : ""}`} onClick={() => selectStudent(student.id)}><span>{student.name.slice(0, 1)}</span><div><b><span>{student.name}</span>{studentHomeworkProgress[student.id] && <i className={studentHomeworkProgress[student.id] === "grading" ? "busy" : undefined} title={studentHomeworkProgress[student.id] === "grading" ? "有作业正在批改" : "有尚未完成的布置作业"}>{studentHomeworkProgress[student.id] === "grading" ? "批改中" : "作业中"}</i>}</b><small>{student.className || "独立学生"}</small></div>{student.wrongCount > 0 && <em>错题 {student.wrongCount}</em>}</button>) : !studentsLoading && <div className="student-list-empty"><span>人</span><b>还没有学生档案</b><p>先创建学生，再上传他的已完成作业。</p></div>}</div>
          </> : <>
          <div className="sidebar-heading" ref={moduleManager}><span className="eyebrow">{pageCopy.moduleSwitcher}</span>{canManageLibrary && <PaperMoreMenu label={pageCopy.manageModules}><button onClick={openNewModule}>{pageCopy.newModule}</button><button onClick={() => setModuleDialog("manage")}>{pageCopy.manageModules}</button></PaperMoreMenu>}</div>
          <div className="tree" aria-label={pageCopy.moduleSwitcher}>{modules.map(examModule => examModule.id === activeModule?.id ? <CategoryTree key={examModule.id} module={examModule} categories={categories} activeId={activeCategory} countFor={countFor} light={showKnowledgeMap && mapOpen ? treeLight : null} onSelect={(id) => { setActiveCategory(id); setMapQuestionId(""); setTypeFilter("全部"); setShowSelected(false); window.scrollTo(0,0); }} /> : <button key={examModule.id} className="tree-row module-root" onClick={() => { switchExamModule(examModule.id); window.scrollTo(0,0); }}><span className="tree-dot">◆</span><span className="tree-name">{examModule.name}</span><span className="count">{countFor(examModule.id)}</span></button>)}</div>
          {canManageLibrary ? <button className="manage-button" onClick={() => setCategoryDialog("manage")} disabled={!activeModule}>{pageCopy.manageCategories}</button> : <button className="manage-button" onClick={() => { setAuthMode("login"); setAuthDialog(true); }}>{pageCopy.loginToDownload}</button>}
          </>}
        </aside>}

        <section className={`content${!showWrongBook && !showSelected ? " library-content" : ""}`}>
          {showWrongBook ? <>
            {!!students.length && <label className="mobile-student-picker"><span>当前学生</span><select value={activeStudentId} onChange={(event) => { if (event.target.value === NEW_STUDENT_OPTION) openStudentDialog(); else selectStudent(event.target.value); }}>{students.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.wrongCount} 道错题</option>)}<option value={NEW_STUDENT_OPTION}>＋ 新建学生</option></select></label>}
            {activeClassName !== null ? <section className="class-profile" aria-label={`${activeClassName}的班级`}>
              <div className="wrong-book-hero"><div className="student-avatar">▦</div><div><h1>{activeClassName}</h1><p className="subtext">{classStudents.length} 位学生 · 每位学生独立记录作业、批改和错题</p></div><div className="wrong-book-stats"><button className="secondary" disabled={classBusy} onClick={() => openClassDialog(activeClassName)}>管理班级</button><button className="homework-cancel" disabled={classBusy} title="删除班级，保留全部学生档案" aria-label={`删除班级：${activeClassName}`} onClick={() => void removeClass(activeClassName)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" /></svg></button></div></div>
              <header className="student-panel-head"><p>班级学生</p><div className="student-panel-actions"><button className="secondary" onClick={() => openStudentDialog()}>新建学生</button><button className="secondary" onClick={() => openClassDialog(activeClassName)}>添加学生</button><button className="primary-button" disabled={!classStudents.length} title={classStudents.length ? "选择练习并布置给全班" : "请先添加学生"} onClick={() => setClassAssigning(true)}>布置作业</button></div></header>
              {classStudents.length ? <div className="class-members">{classStudents.map((student) => <button className="student-card" key={student.id} onClick={() => void selectStudent(student.id)}><span>{student.name.slice(0, 1)}</span><div><b><span>{student.name}</span>{studentHomeworkProgress[student.id] && <i className={studentHomeworkProgress[student.id] === "grading" ? "busy" : undefined} title={studentHomeworkProgress[student.id] === "grading" ? "有作业正在批改" : "有尚未完成的布置作业"}>{studentHomeworkProgress[student.id] === "grading" ? "批改中" : "作业中"}</i>}</b><small>{student.notes || "查看学生档案"}</small></div><em>错题 {student.wrongCount} · →</em></button>)}</div>
                : <div className="student-panel-empty"><b>班级里还没有学生</b><p>可以添加已有学生，或在这个班级下新建学生。</p></div>}
              {classAssigning && <AssignPlan className={activeClassName} handedOut={[]} onClose={() => setClassAssigning(false)} onAssigned={() => { setClassAssigning(false); void loadStudents().catch((error) => show({ text: error instanceof Error ? error.message : "学生读取失败", tone: "error" })); show({ text: "作业已布置，可在每位学生的作业中查看", tone: "success" }); }} />}
            </section> : activeStudent ? <>
              <div className="wrong-book-hero"><div className="student-avatar">{activeStudent.name.slice(0, 1)}</div><div><h1>{activeStudent.name}</h1><p className="subtext">{activeStudent.className ? <button className="student-class-link" onClick={() => setActiveClassName(activeStudent.className)}>{activeStudent.className}</button> : <span>独立学生</span>}<span>错题 <b>{activeStudent.wrongCount}</b></span>{activeStudent.notes && <span title={activeStudent.notes}>{activeStudent.notes.split(/[。！？\n]|[.!?]\s/, 1)[0]}</span>}</p></div><div className="wrong-book-stats"><a className="wrong-book-smart" href={`/tools/smart-paper?student=${encodeURIComponent(activeStudent.id)}`} title="按这位学生的档案从题库挑题、按天排好">智能组卷</a><PaperMoreMenu label={`${activeStudent.name}的档案操作`}><button onClick={() => openStudentDialog(activeStudent)}>编辑档案</button><hr /><button className="danger-text" onClick={() => void removeStudent(activeStudent)}>删除档案…</button></PaperMoreMenu></div></div>
              <div className="archive-tabs" role="tablist" aria-label={`${activeStudent.name}的档案`}>{ARCHIVE_TABS.map(([key, label]) => <button key={key} role="tab" aria-selected={archiveTab === key} className={archiveTab === key ? "active" : ""} onClick={() => chooseArchiveTab(key)}>{label}{key === "wrong" && <span>{activeStudent.wrongCount}</span>}</button>)}</div>
              {archiveTab === "homework" ? <StudentHomework student={activeStudent} progress={studentHomeworkProgress[activeStudent.id] ?? null} onProgressChange={updateHomeworkProgress} /> : archiveTab === "profile" ? <StudentProfile student={activeStudent} /> : archiveTab === "report" ? <StudentReports student={activeStudent} /> : <>
              {!!activeWrongEntries.length && <div className="wrong-book-head"><button className="wrong-upload-link" onClick={() => setWrongUploadOpen(true)}>＋ 新建错题</button></div>}
              <div className="filters"><label className="search"><span>⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); document.querySelector(".wrong-question-list")?.scrollIntoView({ block: "start" }); }} aria-label="搜索学生错题" placeholder="搜索 ID、题干或来源…" /></label><div className="page-language-switch filter-segments" role="group" aria-label="错题月份">
                <button className={`filter ${activeWrongMonth === "全部" ? "active" : ""}`} onClick={() => { setWrongMonth("全部"); document.querySelector(".wrong-question-list")?.scrollIntoView({ block: "start" }); }}>全部 <span>{activeWrongEntries.length}</span></button>
                {wrongMonths.map((month) => <button key={month} className={`filter ${activeWrongMonth === month ? "active" : ""}`} onClick={() => { setWrongMonth(month); document.querySelector(".wrong-question-list")?.scrollIntoView({ block: "start" }); }}>{month} <span>{activeWrongEntries.filter((entry) => wrongMonthOf(entry) === month).length}</span></button>)}
                </div><button className={`select-visible ${allFilteredSelected ? "active" : ""}`} disabled={!selectableIds.length} onClick={toggleAllFiltered}>{allFilteredSelected ? "取消选中" : "选中结果"}</button>
              </div>
              <div className="question-list wrong-question-list">
                {wrongBookLoading ? <div className="wrong-book-loading"><i></i><span>正在读取错题记录…</span></div> : !filteredWrongEntries.length ? <div className="empty-state"><div>错</div><h3>{activeWrongEntries.length ? "没有符合搜索的错题" : "还没有错题记录"}</h3><p>{activeWrongEntries.length ? "换一个关键词继续查找" : "上传学生作业，批改后自动收录错题"}</p>{!activeWrongEntries.length && <button className="wrong-upload-link" onClick={() => setWrongUploadOpen(true)}>＋ 新建错题</button>}</div> : visibleWrongMonths.map((group) => <section className="wrong-month" key={group.month} aria-label={`${group.month}错题`}>
                  <h3 className="wrong-month-head">{group.month}<span>{group.entries.length} 题</span></h3>
                  {group.entries.map((entry, index) => {
                  const question = entry.question; const answerKey = `wrong-${entry.id}`; const answerOpen = expandedAnswers.includes(answerKey); const checked = selectedIds.includes(question.id);
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- The check box is the keyboard control; a click on the card is a pointer shortcut for it.
                  return <article className={`question-card wrong-question-card ${checked ? "checked" : ""}`} key={entry.id} onClick={(event) => selectOnCardClick(event, () => toggleSelected(question.id))}>
                    <button className={`check ${checked ? "on" : ""}`} aria-label={`${checked ? "取消选择" : "选择"}${group.month}第 ${index + 1} 题`} onClick={() => toggleSelected(question.id)}>{checked ? "✓" : ""}</button>
                    <div className="question-main">
                      <div className="meta">{question.code && <span>ID {question.code}</span>}<span>{question.type}</span><span className={question.difficulty === "提高" ? "hard" : question.difficulty === "中等" ? "medium" : "easy"}>{question.difficulty}</span><span className="wrong-count-badge">错 {entry.mistakeCount} 次</span><em>{entry.sourcePath}</em></div>
                      <QuestionBody question={question} number={index + 1} figureAlt="错题配图" />
                      <WrongQuestionEvidence entry={entry} />
                      {answerOpen && <div className="answer-box"><b>答案</b><p><MathText text={question.answer || "略"} /></p>{question.analysis && <><b>解析</b><div className="analysis-content">{question.studioSource ? <StudioSolution source={{...question.studioSource,analysis:question.analysis}}/> : <DocxContent xml={question.analysisDocxXml} fallback={question.analysis} />}</div></>}</div>}
                      <div className="question-actions"><button onClick={() => setExpandedAnswers((current) => current.includes(answerKey) ? current.filter((id) => id !== answerKey) : [...current, answerKey])}>{answerOpen ? "收起解析" : "查看解析"}</button><small>最近记录 {new Date(entry.lastWrongAt).toLocaleDateString("zh-CN")}</small><span></span><button className="danger-text" onClick={() => deleteWrongEntries([entry])}>删除</button></div>
                    </div>
                  </article>;
                })}</section>)}
              </div>
              {!!historicalWrongEntries.length && <details className="wrong-history"><summary>历史记录（{historicalWrongEntries.length}）</summary><p>删除、部分正确及已修正的记录保留在此，不计入当前错题统计；删除的错题可以恢复。</p>{historicalWrongEntries.map(entry => <article key={entry.id}><b>{entry.sourcePath}</b><p><MathText text={entry.question.stem} /></p><small>{entry.archiveReason}</small>{entry.archiveReason === WRONG_QUESTION_DELETED && <button className="secondary" onClick={() => restoreWrongEntries([entry])}>恢复</button>}<WrongQuestionEvidence entry={entry} /></article>)}</details>}
              </>}
            </> : wrongBookLoading ? <div className="wrong-book-loading"><i></i><span>正在读取学生档案…</span></div> : <div className="empty-state wrong-book-empty"><div>人</div><h3>为第一位学生建立档案</h3><p>每位学生有自己的作业、错题和学习记录。</p><button onClick={() => openStudentDialog()}>＋ 新建学生档案</button></div>}
          </> : <>
          {showSelected ? <>
            <aside className="basket-settings">
              <label className="basket-title">练习标题<input value={paperTitle} disabled={basketBusy} onChange={(event) => setPaperTitle(event.target.value)} placeholder="输入练习标题" /></label>
              <label className="basket-answer" htmlFor="basket-include-answers" aria-label="附带答案与解析"><input id="basket-include-answers" type="checkbox" checked={includeAnswers} disabled={basketBusy} onChange={(event) => { setIncludeAnswers(event.target.checked); setTypesetKept((current) => current ? { ...current, settings: { ...current.settings, answers: event.target.checked ? "end" : "none" } } : null); }} /><span><b>附带答案与解析</b><small>文末另起一页</small></span></label>
              <BasketOutline structure={basketStructure} pool={basketPool} disabled={basketBusy} activeId={activeBasketQuestion?.id ?? ""} onChange={setBasketStructure} onLocate={locateBasketQuestion} onGroupByType={() => void classifyBasket()} onNotice={onNotice} />
              <div className="basket-toolbar"><span>已选 {selectedQuestions.length} 题<small role="status">{draftStatus}</small></span><button className="primary-button" disabled={basketBusy || !selectedQuestions.length} onClick={() => void openTypeset()}>快速排版</button><button className="secondary" disabled={basketBusy || !selectedQuestions.length} onClick={generateWord}>{isExporting ? "正在生成…" : "生成 Word"}</button><PaperMoreMenu><button disabled={basketBusy || !selectedQuestions.length && !basketStructure.sections.length} onClick={() => setBasketStructure({ sections: [], unassignedIds: [] })}>清空组卷篮</button></PaperMoreMenu></div>
            </aside>
          </> : <>
          <div className="filters">
            <label className="search"><span>⌕</span><input value={query} onChange={(event) => { const value = event.target.value; setQuery(value); if (!value.trim()) setWrongCatalog(null); if (value.trim() && questions.some(question => question.code === value.trim())) setTypeFilter("全部"); window.scrollTo(0,0); }} aria-label={pageCopy.searchLabel} placeholder={pageCopy.searchPlaceholder} /></label>
            <div className="page-language-switch filter-segments" role="group" aria-label={pageCopy.allTypes}>
              <button className={`filter ${typeFilter === "全部" ? "active" : ""}`} aria-pressed={typeFilter === "全部"} onClick={() => { setTypeFilter("全部"); window.scrollTo(0,0); }}>{pageCopy.all} <span>{byCode ? 1 : categoryQuestions.length}</span></button>
              {questionTypes.filter(type => (byCode ? [byCode] : categoryQuestions).some(item => item.type === type)).map(type => <button key={type} className={`filter ${typeFilter === type ? "active" : ""}`} aria-pressed={typeFilter === type} onClick={() => { setTypeFilter(type); window.scrollTo(0,0); }}>{pageLocale === "en" ? alevelPageLabel(type, pageLocale) : type.replace("单选题", "选择题")} <span>{(byCode ? [byCode] : categoryQuestions).filter(item => item.type === type).length}</span></button>)}
            </div>
            {authUser && <button className={`select-visible ${allFilteredSelected ? "active" : ""}`} disabled={!filteredQuestions.length} onClick={toggleAllFiltered}>{allFilteredSelected ? pageCopy.clearSelection : pageCopy.selectResults}</button>}
            {isAlevelPage && <div className="page-language-switch" role="group" aria-label={pageCopy.language}><button lang="zh-CN" className={alevelPageLocale === "zh" ? "active" : ""} aria-pressed={alevelPageLocale === "zh"} onClick={() => chooseAlevelPageLocale("zh")}>中文</button><button lang="en" className={alevelPageLocale === "en" ? "active" : ""} aria-pressed={alevelPageLocale === "en"} onClick={() => chooseAlevelPageLocale("en")}>English</button></div>}
          </div>
          {!libraryLoading && <div className="library-position">{byCode ? (pageLocale === "en" ? "ID lookup across all modules" : "全题库 ID 查找") : activeName.split(" / ").join(" › ")} · {alevelQuestionCount(filteredQuestions.length, pageLocale)}</div>}
          </>}
          {!!wrongMatches.length && <section className="question-list wrong-catalog" aria-label="错题本中还没进题库的题">
            <h2 className="basket-section-heading">错题本中未入题库<small>{wrongMatches.length} 题 · 可加入题库，ID 不变</small></h2>
            {wrongMatches.map((item, index) => {
              const question = item.question; const answerKey = `catalog-${question.id}`; const answerOpen = expandedAnswers.includes(answerKey);
              return <article className="question-card" key={question.id}>
                <div className="question-main">
                  <div className="meta">{question.code && <span>ID {question.code}</span>}<span>{question.type}</span><span className={question.difficulty === "提高" ? "hard" : question.difficulty === "中等" ? "medium" : "easy"}>{question.difficulty}</span><span className="wrong-count-badge">错 {item.mistakeCount} 次</span><em>错题本 · {item.students.map((student) => student.name).join("、")}</em></div>
                  <QuestionBody question={question} number={index + 1} figureAlt="错题配图" />
                  {answerOpen && <div className="answer-box"><b>答案</b><p><MathText text={question.answer || "略"} /></p>{question.analysis && <><b>解析</b><div className="analysis-content">{question.studioSource ? <StudioSolution source={{...question.studioSource,analysis:question.analysis}}/> : <DocxContent xml={question.analysisDocxXml} fallback={question.analysis} />}</div></>}</div>}
                  <div className="question-actions"><button onClick={() => setExpandedAnswers((current) => current.includes(answerKey) ? current.filter((id) => id !== answerKey) : [...current, answerKey])}>{answerOpen ? "收起解析" : "查看解析"}</button><small>最近记录 {new Date(item.lastWrongAt).toLocaleDateString("zh-CN")}</small><span></span>{canManageLibrary && <button onClick={() => void addWrongToLibrary(item)}>加入题库</button>}</div>
                </div>
              </article>;
            })}
          </section>}
          <div className="question-list">
            {!filteredQuestions.length && !wrongMatches.length && (libraryLoading ? <div className="wrong-book-loading"><i></i><span>{showSelected ? "正在读取组卷篮…" : "正在读取题库…"}</span></div> : <div className={`empty-state ${showSelected ? "basket-empty" : ""}`}><div>{pageCopy.empty}</div><h3>{showSelected ? "组卷篮还是空的" : !activeModule ? "创建第一个模块" : pageCopy.noQuestions}</h3><p>{showSelected ? "到题库勾选题目或从学生错题本加入，再回来调整顺序并生成练习。" : !activeModule ? canManageLibrary ? "模块可以是考试、学科或你习惯的任意分组" : "登录后即可创建模块和录题" : canManageLibrary ? pageCopy.addFirstQuestion : pageCopy.noResources}</p>{showSelected ? <button onClick={() => setShowSelected(false)}>去题库选题</button> : canManageLibrary ? <button onClick={activeModule ? openNewQuestion : openNewModule}>{activeModule ? pageCopy.newQuestion : pageCopy.newModule}</button> : null}</div>)}
            {filteredQuestions.slice(0, visibleCount).map((question, index) => {
              const path = pathOf(question.categoryId);
              const section = showSelected ? paperSections.find((item) => index >= item.start && index < item.start + item.questions.length) : undefined;
              return <Fragment key={question.id}>
                {section?.heading && index === section.start && <h2 className="basket-section-heading">{section.heading}<small>{section.questions.length} 题</small></h2>}
                <LibraryQuestionCard question={question} index={index} isFirst={section ? index === section.start : index === 0} isLast={section ? index === section.start + section.questions.length - 1 : index === filteredQuestions.length - 1}
                  sectionId={section?.id} sections={showSelected ? sectionChoices : undefined}
                  path={showSelected || query.trim() || activeName !== path ? path : ""} checked={selectedIds.includes(question.id)} active={showSelected ? question.id === activeBasketQuestion?.id : mapOpen && question.id === mapQuestion?.id} answerOpen={expandedAnswers.includes(question.id)} selectable={Boolean(authUser) && !showSelected}
                  basket={showSelected} canDelete={canDelete} isExporting={basketBusy} isAlevelPage={isAlevelPage} pageLocale={pageLocale} actions={cardActions} />
              </Fragment>;
            })}
          </div>
          {filteredQuestions.length > visibleCount && <div ref={listEndRef} className="question-list-end" aria-hidden="true" />}
          </>}
        </section>
        {showKnowledgeMap && <div className={`kgl-dock ${mapOpen ? "open" : ""}`}>
          {knowledgeMapFocus && activeModule && <LibraryKnowledgeMap focus={knowledgeMapFocus} moduleId={activeModule.id} categories={categories} onLight={setTreeLight} onCollapse={collapseMap} />}
          <KnowledgeMapRail open={mapOpen} onExpand={expandMap} />
        </div>}
      </section>

{authUser && !showSelected && !!selectedQuestions.length && <aside className="paper-dock visible"><div className="dock-count"><strong>{selectedQuestions.length}</strong><span>{pageCopy.selectedQuestions}</span></div><div className="dock-title"><b>{showWrongBook ? "该学生" : pageCopy.selectionHere} {alevelQuestionCount(selectedHere, pageLocale)}{selectedQuestions.length > selectedHere && ` · ${showWrongBook ? "其他来源" : pageCopy.selectionElsewhere} ${alevelQuestionCount(selectedQuestions.length - selectedHere, pageLocale)}`}</b><span>{pageCopy.basketReadyHint}</span></div>{showWrongBook ? !!selectedWrongEntries.length && <button className="ghost-button dock-delete-button" onClick={() => deleteWrongEntries(selectedWrongEntries)}>{pageCopy.delete}</button> : canDelete && <button className="ghost-button dock-delete-button" onClick={deleteSelectedQuestions}>{pageCopy.delete}</button>}<button className="ghost-button" onClick={() => setSelectedIds([])}>{pageCopy.clearSelection}</button><button className="export-button" onClick={() => { setShowWrongBook(false); setShowSelected(true); }}>{pageCopy.navBasket} <span>→</span></button></aside>}

      {entryDraft && <QuestionEntry initial={entryDraft} modules={modules} categories={categories} moduleIds={[entryDraft.moduleId || activeModule?.id || ""]} addToLibrary={entryAddsWrong} onClose={() => { setEntryDraft(null); setEntryAddsWrong(false); }} onNotice={onNotice} onSaved={(saved) => { setQuestions((current) => [...saved, ...current.filter((item) => !saved.some((entry) => entry.id === item.id))].sort((a, b) => b.createdAt - a.createdAt)); if (entryAddsWrong) setWrongCatalog((current) => current?.filter((item) => !saved.some((entry) => entry.id === item.question.id)) ?? null); }} />}

      {categoryDialog && activeModule && <div className="modal-backdrop"><section className="modal category-modal" role="dialog" aria-modal="true" aria-label="分类管理">
        <div className="modal-head"><div><span className="eyebrow">{activeModule.name}</span><h2>{categoryDialog === "new" ? "新建模块内分类" : categoryDialog === "trash" ? "回收站" : "分类与数据管理"}</h2></div><button className="close" onClick={() => setCategoryDialog(null)}>×</button></div>
        {categoryDialog === "new" ? <>
          <label className="field">分类名称<input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="例如：二次函数" /></label>
          <label className="field">上级分类<select value={categoryParent || activeModule.id} onChange={(event) => setCategoryParent(event.target.value)}><option value={activeModule.id}>{activeModule.name}（模块根目录）</option>{moduleCategories.map((item) => <option key={item.id} value={item.id}>{pathOf(item.id)}</option>)}</select></label>
          <div className="modal-actions"><button className="secondary" onClick={() => setCategoryDialog(null)}>取消</button><button className="primary-button" onClick={createCategory}>创建分类</button></div>
        </> : categoryDialog === "trash" ? <>
          <div className="manage-list trash-list">{!trashQuestions ? <p className="empty-tree">正在读取回收站…</p> : trashQuestions.some((item) => item.moduleId === activeModule.id) ? trashQuestions.filter((item) => item.moduleId === activeModule.id).map((item) => <div key={item.id}><span><b><MathText text={item.stem.split("\n")[0]} /></b><small>{item.code && `ID ${item.code} · `}{pathOf(item.categoryId) || `${activeModule.name}（原分类已删除，恢复到模块根目录）`} · {new Date(item.deletedAt).toLocaleDateString("zh-CN")} 删除</small></span><button disabled={restoringIds.includes(item.id)} onClick={() => restoreTrashQuestion(item.id)}>{restoringIds.includes(item.id) ? "恢复中…" : "恢复"}</button></div>) : <p className="empty-tree">回收站是空的</p>}</div>
          <div className="modal-actions"><button className="secondary" onClick={() => setCategoryDialog("manage")}>返回</button><button className="primary-button" onClick={() => setCategoryDialog(null)}>完成</button></div>
        </> : <>
          <div className="manage-list">{moduleCategories.length ? moduleCategories.map((item) => <div key={item.id}><span><b>{item.name}</b><small>{pathOf(item.id)} · {countFor(item.id)} 题</small></span>{canDelete && <button onClick={() => deleteCategory(item)}>删除</button>}</div>) : <p className="empty-tree">当前模块还没有子分类</p>}</div>
          <div className="data-tools"><div><b>题库备份</b><small>备份包含动态模块、分类和题目；导入会追加到当前题库。</small></div><button className="secondary" onClick={() => importRef.current?.click()}>导入备份</button><button className="secondary" onClick={exportBackup}>导出备份</button><input ref={importRef} type="file" accept="application/json" hidden onChange={importBackup} /></div>
          {canDelete && <div className="data-tools"><div><b>回收站</b><small>删除的试题保留在这里，可恢复到原分类。</small></div><button className="secondary" onClick={openTrash}>打开</button></div>}
          <div className="modal-actions"><button className="secondary" onClick={() => { setCategoryParent(activeCategory ?? activeModule.id); setCategoryDialog("new"); }}>＋ {pageCopy.addCategory}</button><button className="primary-button" onClick={() => setCategoryDialog(null)}>完成</button></div>
        </>}
      </section></div>}

      {moduleDialog && <div className="modal-backdrop"><section className="modal module-modal" role="dialog" aria-modal="true" aria-label="模块管理">
        <div className="modal-head"><div><span className="eyebrow">{pageCopy.publicLibrary}</span><h2>{moduleDialog === "new" ? moduleDraft ? "编辑模块" : "新建模块" : "模块管理"}</h2></div><button className="close" onClick={() => { setModuleDialog(null); setModuleDraft(null); }}>×</button></div>
        {moduleDialog === "new" ? <>
          <label className="field">模块名称<input value={moduleName} onChange={(event) => setModuleName(event.target.value)} placeholder="例如：深圳中考" /></label>
          <label className="field">副标题<input value={moduleSubtitle} onChange={(event) => setModuleSubtitle(event.target.value)} placeholder="例如：数学真题与专题训练" /></label>
          <div className="modal-actions"><button className="secondary" onClick={() => setModuleDialog(moduleDraft ? "manage" : null)}>取消</button><button className="primary-button" onClick={saveModule}>{moduleDraft ? "保存修改" : "创建模块"}</button></div>
        </> : <>
          <div className="module-manage-list">{modules.map((item, index) => <div key={item.id} draggable onDragStart={() => setDraggedModuleId(item.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropModule(item.id)}>
            <span className="drag-handle" title="拖动排序">⋮⋮</span><span><b>{item.name}</b><small>{item.subtitle || "未设置副标题"} · {countFor(item.id)} 题</small></span><div><button title="上移" aria-label={`上移${item.name}`} disabled={index === 0} onClick={() => moveModule(item.id, -1)}>↑</button><button title="下移" aria-label={`下移${item.name}`} disabled={index === modules.length - 1} onClick={() => moveModule(item.id, 1)}>↓</button><button onClick={() => openModuleEditor(item)}>编辑</button>{canDelete && <button className="danger-text" onClick={() => void removeModule(item)}>删除</button>}</div>
          </div>)}</div>
          <div className="modal-actions"><button className="secondary" onClick={openNewModule}>＋ 新建模块</button><button className="primary-button" onClick={() => setModuleDialog(null)}>完成</button></div>
        </>}
      </section></div>}

      {studentDialog && <div className="modal-backdrop"><section className="modal student-modal" role="dialog" aria-modal="true" aria-label={studentDraft ? "编辑学生档案" : "新建学生档案"}>
        <div className="modal-head"><div><span className="eyebrow">学生专属空间</span><h2>{studentDraft ? "编辑学生档案" : "新建学生档案"}</h2></div><button className="close" onClick={() => setStudentDialog(false)}>×</button></div>
        <label className="field">学生姓名或昵称<input value={studentName} onChange={(event) => setStudentName(event.target.value)} placeholder="例如：小宇" /></label>
        <label className="field">班级（选填，留空为独立学生）<input list="student-class-names" maxLength={80} value={studentClassName} onChange={(event) => setStudentClassName(event.target.value)} placeholder="选择已有班级，或输入新班级名称" /><datalist id="student-class-names">{studentClasses.map((name) => <option key={name} value={name} />)}</datalist></label>
        <label className="field">学习备注（选填）<textarea rows={4} value={studentNotes} onChange={(event) => setStudentNotes(event.target.value)} placeholder="例如：几何基础较好，函数综合题需要加强" /></label>
        <div className="modal-actions"><button className="secondary" onClick={() => setStudentDialog(false)}>取消</button><button className="primary-button" onClick={saveStudent}>{studentDraft ? "保存档案" : "创建学生"}</button></div>
      </section></div>}

      {classDialog && <div className="modal-backdrop"><section className="modal assign-modal" role="dialog" aria-modal="true" aria-label={classDialog.previousName === undefined ? "新建班级" : "管理班级"} aria-busy={classBusy}>
        <div className="modal-head"><div><span className="eyebrow">学生分组</span><h2>{classDialog.previousName === undefined ? "新建班级" : "管理班级"}</h2></div><button className="close" aria-label="关闭" disabled={classBusy} onClick={() => setClassDialog(null)}>×</button></div>
        <label className="field">班级名称<input maxLength={80} disabled={classBusy} value={classDialog.name} onChange={(event) => setClassDialog({ ...classDialog, name: event.target.value })} placeholder="例如：初一（1）班" /></label>
        <fieldset className="assign-students class-students" disabled={classBusy}><legend>班级学生 · 已选 {classDialog.studentIds.length} 人</legend>
          {students.length ? students.map((student) => <label key={student.id} className={classDialog.studentIds.includes(student.id) ? "on" : ""}><input type="checkbox" checked={classDialog.studentIds.includes(student.id)} onChange={() => setClassDialog((current) => current && ({ ...current, studentIds: current.studentIds.includes(student.id) ? current.studentIds.filter((id) => id !== student.id) : [...current.studentIds, student.id] }))} /><b>{student.name}</b><small>{student.className && student.className !== classDialog.previousName ? `从${student.className}移入` : student.className || "独立学生"}</small></label>) : <p>可以先创建班级，再在班级下新建学生。</p>}
        </fieldset>
        <p className="assign-hint">每位学生可以加入一个班级。取消勾选后成为独立学生；转班、移出或删除班级都会保留学生已有的作业、批改和错题。</p>
        {classError && <p className="assign-error" role="alert">{classError}</p>}
        <div className="modal-actions"><button className="secondary" disabled={classBusy} onClick={() => setClassDialog(null)}>取消</button><button className="primary-button" disabled={classBusy || !classDialog.name.trim()} onClick={() => void saveClass()}>{classBusy ? "正在保存…" : classDialog.previousName === undefined ? "创建班级" : "保存班级"}</button></div>
      </section></div>}

      {wrongUploadOpen && activeStudent && <WrongQuestionUpload student={activeStudent} onClose={() => setWrongUploadOpen(false)} onGraded={(submission) => { void loadStudents(submission.studentId); if (submission.status !== "published") return; const archived = submission.gradingSummary?.archived ?? 0; setWrongUploadOpen(false); show({ text: archived ? `已收录 ${archived} 道错题` : "批改完成，没有需要收录的错题", tone: "success" }); }} />}


      {authDialog && <div className="modal-backdrop"><section className="modal auth-modal" role="dialog" aria-modal="true" aria-label={authMode === "login" ? "登录" : "注册"}>
        <div className="modal-head"><div><span className="eyebrow">MathPilot</span><h2>{authMode === "login" ? "邮箱登录" : "使用邀请码注册"}</h2></div><button className="close" onClick={() => setAuthDialog(false)}>×</button></div>
        <div className="auth-tabs"><button className={authMode === "login" ? "active" : ""} onClick={() => { setAuthMode("login"); setAuthError(""); }}>登录</button><button className={authMode === "register" ? "active" : ""} onClick={() => { setAuthMode("register"); setAuthError(""); }}>注册</button></div>
        <label className="field">邮箱<input type="email" autoComplete="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="name@example.com" /></label>
        <label className="field">密码<input type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="至少 8 个字符" onKeyDown={(event) => { if (event.key === "Enter") submitAuth(); }} /></label>
        {authMode === "register" && <label className="field">邀请码<input value={authInvite} onChange={(event) => setAuthInvite(event.target.value)} placeholder="请输入管理员提供的邀请码" onKeyDown={(event) => { if (event.key === "Enter") submitAuth(); }} /></label>}
        {authError && <div className="recognition-error"><b>{authMode === "login" ? "登录未完成" : "注册未完成"}</b><span>{authError}</span></div>}
        <p className="auth-note">访客无需登录即可浏览题目；注册后可以录题、组卷和下载 Word。普通会员只能修改自己录入的题目。</p>
        <div className="modal-actions"><button className="secondary" onClick={() => setAuthDialog(false)}>取消</button><button className="primary-button" disabled={authSubmitting || !authEmail || !authPassword || (authMode === "register" && !authInvite)} onClick={submitAuth}>{authSubmitting ? "请稍候…" : authMode === "login" ? "登录" : "注册并登录"}</button></div>
      </section></div>}
      {confirmDialog}
      {toastNode}
    </main>
  );
}
