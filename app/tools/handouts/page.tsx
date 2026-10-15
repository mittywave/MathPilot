"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- client-only vinext navigation */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { arrangeHandouts, authorizeDownload, createCloudQuestion, createHandout, deleteHandout, fetchHandout, fetchHandouts, fetchLibrary, fetchMe, fetchStudents, saveHandoutCourse, deleteHandoutCourse, updateHandout, uploadHandoutImage } from "../../../lib/api-client";
import { saveQuestionImportBatch } from "../../../lib/question-import-save.mjs";
import { DEFAULT_HANDOUT_TITLE, HANDOUT_BANDS, HANDOUT_DOMAINS, HANDOUT_LIMITS, HANDOUT_PARTS, HANDOUT_SHEETS, HANDOUT_SHELVES, UNSORTED_TOPIC_LABEL, copyHandoutItems, coursePath, ensureLeadingModule, groupLabel, handoutModules, handoutNumbers, handoutSections, insertIndexForSection, moduleHeading, moveHandoutItem, questionPoints, removeHandoutModule, sameGroup, setItemBand, sheetLabel, sheetQuestions, shelfOf } from "../../../lib/handout-rules.mjs";
import { categoryPath } from "../../../lib/library-tree";
import type { WordAnswerPlacement } from "../../../lib/export-word";
import type { LatexStatus } from "../../../lib/handout-latex-files";
import { noteFromBlocks, type RecognizedNoteFigure } from "../../../lib/handout-note.mjs";
import { clipboardImage } from "../../../lib/image-tools";
import { randomClientId } from "../../../lib/client-random-id.mjs";
import { droppedImage, readScreenshot, recognizeScreenshot } from "../../../lib/screenshot-recognition";
import type { NoteRecognitionResult } from "../../../lib/recognition-contract";
import type { AuthUser, Handout, HandoutBand, HandoutDomain, HandoutCourseNode, HandoutGroup, HandoutItem, HandoutSheet, HandoutShelf, HandoutSummary, LibraryData, Question, StudentSummary } from "../../../lib/types";
import { PaperMoreMenu } from "../../components/PaperMoreMenu";
import { QuestionBody } from "../../components/QuestionBody";
import { editableQuestionDraft, newQuestionDraft, QuestionEntry } from "../../components/QuestionEntry";
import { SiteHeader } from "../../components/SiteHeader";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { QuestionPicker, type PickerMode } from "./QuestionPicker";
import { NotePreview } from "./NotePreview";
import "../tools.css";
import "./handouts.css";
import "../../components/note-editor.css";

type SaveState = "saved" | "editing" | "saving" | "failed";
type EntryState = { draft: Question; sectionId: string | null; band: HandoutBand; sheet: HandoutSheet; temporary?: boolean };
type SectionItem = Extract<HandoutItem, { kind: "section" }>;
type QuestionItem = Extract<HandoutItem, { kind: "question" }>;
type ListSheet = Exclude<HandoutSheet, "handout">;
type ListItem = Extract<HandoutItem, { kind: ListSheet }>;
type ExportFormat = "pdf" | "word";

const ENTRY_CATEGORY_KEY = "mitty-handout-entry-category";
// listHint is shown for 小测 and 作业, which have no 例题/练习/变式.
const ANSWER_CHOICES: { value: WordAnswerPlacement; label: string; hint: string; listHint: string }[] = [
  { value: "none", label: "不附", hint: "学生版：例题留课堂笔记区，练习和变式留作答空间。", listHint: "学生版：解答题留作答空间。" },
  { value: "end", label: "文末", hint: "学生版正文，答案与解析按例题、练习、变式分组附在文末。", listHint: "学生版正文，答案与解析附在文末。" },
  { value: "each", label: "每题后", hint: "教师版：每道题后紧跟答案与解析。", listHint: "教师版：每道题后紧跟答案与解析。" },
];
// The editor engine loads with the first module; until then the note shows as it reads.
const NoteEditor = lazy(() => import("../../components/NoteEditor"));
// crypto.randomUUID only exists on secure origins; colleagues use the plain-http LAN address.
const newId = () => randomClientId();

function BackIcon() {
  return <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m10 5-7 7 7 7M3 12h18" /></svg>;
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function readStored(key: string) { try { return window.localStorage.getItem(key) ?? ""; } catch { return ""; } }
function writeStored(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* 浏览器禁用本地存储时只是不记住上次的分类 */ } }

// A small menu closes when the pointer goes down anywhere outside it.
function closeOutside(menu: HTMLDetailsElement) {
  if (!menu.open) return;
  const close = (event: PointerEvent) => {
    if (menu.contains(event.target as Node)) return;
    menu.open = false; document.removeEventListener("pointerdown", close);
  };
  document.addEventListener("pointerdown", close);
}
const closeMenu = (item: HTMLElement) => { const menu = item.closest("details"); if (menu) menu.open = false; };

export default function HandoutsPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toastNode, show] = useToast();
  const onNotice = useCallback((text: string, tone: "success" | "error" = "success") => show({ text, tone }), [show]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    void fetchMe().then((result) => { setOpenId(id); setUser(result.user); }).catch(() => show({ text: "登录状态读取失败，请刷新重试", tone: "error" })).finally(() => setLoaded(true));
  }, [show]);

  // The list sits under the shared site header; an open handout's editor takes the whole window.
  if (!loaded) return <><SiteHeader active="handouts" user={null} loading /><main className="toolbox handouts"><p>正在读取…</p></main></>;
  if (!user) return <><SiteHeader active="handouts" user={null} /><main className="toolbox handouts"><p>请先登录 MathPilot。</p><a href="/">返回题库</a></main></>;
  return <>
    {openId ? <HandoutEditor id={openId} onNotice={onNotice} /> : <><SiteHeader active="handouts" user={user} /><HandoutList isAdmin={user.role === "admin"} onNotice={onNotice} /></>}
    {toastNode}
  </>;
}

const SHELF_KEY = "mitty-handout-shelf";
const COURSE_KEY = "mitty-handout-course";
const STAGE_KEY = "mitty-handout-stage";
const STUDENT_KEY = "mitty-handout-student";
type MoveState = { handout: HandoutSummary; shelf: HandoutShelf; courseUnitId: string; domain: HandoutDomain; studentId: string };
const lessonName = (index: number) => `第${index + 1}讲`;
const NOWHERE: HandoutGroup = { courseUnitId: null, domain: null, studentId: null };
const groupOf = ({ courseUnitId, domain, studentId }: HandoutGroup): HandoutGroup => ({ courseUnitId, domain, studentId });
const knownShelf = (value: string | null) => HANDOUT_SHELVES.find((item) => item.value === value)?.value;
const questionTotal = (handout: HandoutSummary) => handout.outline.reduce((sum, module) => sum + module.questionIds.length, 0);
// 有理数的分类；数轴；相反数: module titles without any number typed in front, split by ； because titles use 、 themselves; untitled modules are left out.
const moduleList = (handout: HandoutSummary) => handout.outline.map((module) => moduleHeading(module.title, 0).title).filter(Boolean).join("；");
const shortDate = (time: number) => new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });

// The group a handout joins from the move dialog's choices.
function movedGroup(state: MoveState): HandoutGroup {
  if (state.shelf === "student") return { ...NOWHERE, studentId: state.studentId || null };
  if (state.shelf === "course") return { ...NOWHERE, courseUnitId: state.courseUnitId || null };
  return { ...NOWHERE, domain: state.domain };
}

// 课程体系和专题库全员共用：任何老师都能新建、编辑、调整顺序，删除只开放给管理员。学生讲义只有学生的老师能看到和管理。
// 左侧选择体系和阶段，右侧并列单元；每讲继续使用同一个编辑器。
function HandoutList({ isAdmin, onNotice }: { isAdmin: boolean; onNotice: (message: string, tone?: "success" | "error") => void }) {
  const [confirmNode, confirm] = useConfirm();
  const [link] = useState(() => new URLSearchParams(window.location.search));
  const linkShelf = knownShelf(link.get("shelf"));
  const [handouts, setHandouts] = useState<HandoutSummary[] | null>(null);
  const [students, setStudents] = useState<StudentSummary[] | null>(null);
  const [shelf, setShelf] = useState<HandoutShelf>(() => linkShelf ?? knownShelf(readStored(SHELF_KEY)) ?? "course");
  const [courseNodes, setCourseNodes] = useState<HandoutCourseNode[] | null>(null);
  const [courseId, setCourseId] = useState(() => link.get("course") || (link.get("grade") ? "course-default" : readStored(COURSE_KEY)));
  const [stageId, setStageId] = useState(() => link.get("stage") || (link.get("grade") ? `course-grade-${link.get("grade")}` : readStored(STAGE_KEY)));
  const [outlineEdit, setOutlineEdit] = useState<{ id?: string; parentId: string | null; name: string; label: string; error: string } | null>(null);
  const [lessonDraft, setLessonDraft] = useState<{ group: HandoutGroup; title: string; modules: string; error: string } | null>(null);
  const systems = (courseNodes ?? []).filter((node) => !node.parentId);
  const activeSystem = systems.find((node) => node.id === courseId) ?? systems[0];
  const stages = (courseNodes ?? []).filter((node) => node.parentId === activeSystem?.id);
  const activeStage = stages.find((node) => node.id === stageId) ?? stages[0];
  const units = (courseNodes ?? []).filter((node) => node.parentId === activeStage?.id);
  const labelGroup = (group: HandoutGroup & { studentName?: string | null }) => groupLabel({ ...group, coursePath: coursePath(courseNodes ?? [], group.courseUnitId) });
  const [studentId, setStudentId] = useState(() => (linkShelf === "student" && link.get("student")) || readStored(STUDENT_KEY));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<MoveState | null>(null);
  const activeStudent = students?.find((item) => item.id === studentId) ?? students?.[0] ?? null;

  useEffect(() => {
    void fetchHandouts().then((result) => { setHandouts(result.handouts); setCourseNodes(result.courseNodes); }).catch((error) => { setHandouts([]); onNotice(error instanceof Error ? error.message : "讲义列表读取失败", "error"); });
    void fetchStudents().then((result) => setStudents(result.students)).catch(() => setStudents([]));
  }, [onNotice]);

  // The address and storage follow the view, so reloading, coming back from the editor and returning later all land here.
  useEffect(() => {
    if (!courseNodes) return;
    writeStored(SHELF_KEY, shelf);
    if (activeSystem) writeStored(COURSE_KEY, activeSystem.id);
    if (activeStage) writeStored(STAGE_KEY, activeStage.id);
    if (activeStudent) writeStored(STUDENT_KEY, activeStudent.id);
    const params = new URLSearchParams({ shelf });
    if (shelf === "course" && activeSystem) {
      params.set("course", activeSystem.id);
      if (activeStage) params.set("stage", activeStage.id);
    } else if (shelf === "student" && activeStudent) params.set("student", activeStudent.id);
    window.history.replaceState(null, "", `/tools/handouts?${params}`);
  }, [shelf, courseNodes, activeSystem, activeStage, activeStudent]);

  function choose(next: HandoutShelf, value?: string) {
    setShelf(next); setQuery("");
    if (next === "course" && value) {
      const node = courseNodes?.find((item) => item.id === value);
      if (node?.parentId) { setCourseId(node.parentId); setStageId(node.id); }
      else { setCourseId(value); setStageId(""); }
    }
    if (next === "student" && value) setStudentId(value);
  }

  async function saveOutline() {
    if (!outlineEdit || busy) return;
    setBusy(true);
    try {
      const result = await saveHandoutCourse({ id: outlineEdit.id, parentId: outlineEdit.parentId, name: outlineEdit.name });
      setCourseNodes(result.courseNodes); setOutlineEdit(null); setShelf("course"); setQuery("");
      const path = coursePath(result.courseNodes, result.id);
      setCourseId(path[0].id); setStageId(path[1]?.id ?? "");
      onNotice("大纲已保存");
    } catch (error) { setOutlineEdit({ ...outlineEdit, error: error instanceof Error ? error.message : "大纲保存失败" }); }
    finally { setBusy(false); }
  }

  async function changeNode(node: HandoutCourseNode, direction?: -1 | 1) {
    if (busy) return;
    if (!direction && !await confirm({ title: `删除目录「${node.name}」`, body: "只能删除没有下级目录、没有讲义的空目录。删除后无法恢复。", confirmLabel: "删除目录", danger: true })) return;
    setBusy(true);
    try {
      const result = direction ? await saveHandoutCourse({ id: node.id, direction }) : await deleteHandoutCourse(node.id);
      setCourseNodes(result.courseNodes); onNotice(direction ? "顺序已调整" : "空目录已删除");
    } catch (error) { onNotice(error instanceof Error ? error.message : "大纲调整失败", "error"); }
    finally { setBusy(false); }
  }

  const nodeMenu = (node: HandoutCourseNode) => {
    const siblings = (courseNodes ?? []).filter((item) => item.parentId === node.parentId);
    const index = siblings.findIndex((item) => item.id === node.id);
    return <PaperMoreMenu label={`${node.name} 目录操作`}>
      <button disabled={busy} onClick={() => setOutlineEdit({ id: node.id, parentId: node.parentId, name: node.name, label: "目录", error: "" })}>重命名</button>
      <button disabled={busy || index === 0} onClick={() => changeNode(node, -1)}>上移</button>
      <button disabled={busy || index === siblings.length - 1} onClick={() => changeNode(node, 1)}>下移</button>
      {isAdmin && <><hr /><button disabled={busy} className="danger-text" onClick={() => changeNode(node)}>删除空目录…</button></>}
    </PaperMoreMenu>;
  };
  const addNode = (parentId: string | null, label: string) => setOutlineEdit({ parentId, label, name: "", error: "" });

  // The server lists by position, so every group is already in order.
  const inGroup = (group: HandoutGroup) => (handouts ?? []).filter((item) => sameGroup(item, group));
  const countIn = (group: HandoutGroup) => inGroup(group).length;
  const studentName = (id: string | null) => students?.find((item) => item.id === id)?.name ?? "";
  // 初一暑假 第1讲 / 几何专题 / 某某
  const placeLabel = (group: HandoutGroup & { studentName?: string | null }, index: number) =>
    group.studentId ? group.studentName || studentName(group.studentId) : group.courseUnitId ? `${labelGroup(group)} ${lessonName(index)}` : labelGroup(group);

  // A new handout goes to the end of its group; a copy goes to the end of the original's group.
  async function create(group: HandoutGroup, source?: HandoutSummary, outline?: { title: string; modules: string; open: boolean }) {
    if (busy) return;
    if (group.courseUnitId && !source && !outline) { setLessonDraft({ group, title: "", modules: "", error: "" }); return; }
    const moduleTitles = (outline?.modules ?? "").split("\n").map((title) => title.trim()).filter(Boolean);
    if (outline && (moduleTitles.length > HANDOUT_LIMITS.items || moduleTitles.some((title) => title.length > HANDOUT_LIMITS.sectionTitle))) {
      setLessonDraft((current) => current && { ...current, error: `每讲最多 ${HANDOUT_LIMITS.items} 个模块，每个模块名最多 ${HANDOUT_LIMITS.sectionTitle} 字` }); return;
    }
    setBusy(true);
    try {
      const draft = source ? (await fetchHandout(source.id)).handout : null;
      const { handout } = await createHandout(draft
        ? { title: `${draft.title}（副本）`, items: copyHandoutItems(draft.items, newId), temporaryQuestions: draft.temporaryQuestions, ...group }
        : { title: outline?.title.trim() || DEFAULT_HANDOUT_TITLE, items: moduleTitles.map((title) => ({ id: newId(), kind: "section" as const, title, note: "" })), ...group });
      if (outline && !outline.open) {
        setHandouts((current) => [...(current ?? []), { ...handout, outline: handout.items.filter((item) => item.kind === "section").map((item) => ({ title: item.title, questionIds: [] })), sheetCounts: { quiz: 0, homework: 0 } }]);
        setLessonDraft(null); setBusy(false); onNotice("本讲大纲已保存，点击讲名可继续编写讲义"); return;
      }
      window.location.assign(`/tools/handouts?id=${encodeURIComponent(handout.id)}`);
    } catch (error) { const message = error instanceof Error ? error.message : "讲义创建失败"; if (lessonDraft) setLessonDraft({ ...lessonDraft, error: message }); else onNotice(message, "error"); setBusy(false); }
  }

  // Positions follow the order sent; the list updates first and rolls back if the server refuses.
  async function arrange(group: HandoutGroup, ids: string[], message: string) {
    if (busy) return;
    setBusy(true);
    const before = handouts;
    const position = new Map(ids.map((id, index) => [id, index]));
    const name = group.studentId ? studentName(group.studentId) : null;
    setHandouts((current) => current && current.map((item) => position.has(item.id) ? { ...item, ...group, studentName: name, position: position.get(item.id)! } : item)
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt));
    try { await arrangeHandouts(group, ids); onNotice(message); }
    catch (error) { setHandouts(before); onNotice(error instanceof Error ? error.message : "讲义调整失败", "error"); }
    finally { setBusy(false); }
  }

  function shift(handout: HandoutSummary, direction: -1 | 1) {
    const group = groupOf(handout);
    const ids = inGroup(group).map((item) => item.id);
    const from = ids.indexOf(handout.id); const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void arrange(group, ids, group.courseUnitId ? `已调到${lessonName(to)}` : "已调整顺序");
  }

  function openMove(handout: HandoutSummary) {
    const from = shelfOf(handout);
    setMoving({ handout, shelf: from, courseUnitId: handout.courseUnitId ?? units[0]?.id ?? "", domain: handout.domain ?? HANDOUT_DOMAINS[0].value, studentId: handout.studentId ?? activeStudent?.id ?? "" });
  }

  function move(state: MoveState) {
    const group = movedGroup(state);
    setMoving(null);
    if (sameGroup(state.handout, group)) return;
    const ids = [...inGroup(group).map((item) => item.id), state.handout.id];
    void arrange(group, ids, `已移到${placeLabel(group, ids.length - 1)}`);
  }

  async function remove(handout: HandoutSummary) {
    if (!await confirm({ title: `删除讲义「${handout.title}」`, body: "讲义和本讲临时题库会一起删除，无法恢复。已存入正式题库的题不受影响。", confirmLabel: "删除讲义", danger: true })) return;
    try { await deleteHandout(handout.id); setHandouts((current) => current?.filter((item) => item.id !== handout.id) ?? null); onNotice("讲义已删除"); }
    catch (error) { onNotice(error instanceof Error ? error.message : "讲义删除失败", "error"); }
  }

  // One line of the contents: lesson number, title, its modules and how many questions its 讲义, 小测 and 作业 hold.
  const entry = (handout: HandoutSummary, order: { index: number; size: number } | null, place?: string) => {
    const modules = moduleList(handout);
    const counts = [questionTotal(handout), handout.sheetCounts.quiz, handout.sheetCounts.homework];
    const numbered = Boolean(order && handout.courseUnitId && !place);
    return <li className="handout-entry row-tail" key={handout.id}>
      <a className={numbered ? "numbered" : undefined} aria-label={`${handout.title}，${HANDOUT_SHEETS.map((sheet, index) => `${sheet.label} ${counts[index]} 题`).join("，")}`} href={`/tools/handouts?id=${encodeURIComponent(handout.id)}`}>
        {numbered && order ? <span className="handout-entry-no" aria-label={lessonName(order.index)}>{order.index + 1}</span> : null}
        <span className="handout-entry-main">
          {place && <small>{place}</small>}
          <strong>{handout.title}</strong>
          {modules && <span>{modules}</span>}
          {counts.some(Boolean) && <span className="handout-entry-count" aria-hidden="true">{HANDOUT_SHEETS.flatMap((sheet, index) => counts[index] ? [`${sheet.label} ${counts[index]}`] : []).join(" · ")}</span>}
        </span>
      </a>
      <PaperMoreMenu label={`${handout.title} 更多操作`}>
        {order && order.size > 1 && <>
          <button disabled={busy || order.index === 0} onClick={() => shift(handout, -1)}>上移</button>
          <button disabled={busy || order.index === order.size - 1} onClick={() => shift(handout, 1)}>下移</button>
        </>}
        <button disabled={busy} onClick={() => create(groupOf(handout), handout)}>复制一份</button>
        <button onClick={() => openMove(handout)}>移到…</button>
        {(isAdmin || handout.studentId) && <><hr /><button className="danger-text" onClick={() => remove(handout)}>删除…</button></>}
      </PaperMoreMenu>
    </li>;
  };
  // addLabel null: nothing new is started here (the unsorted topics only wait to be moved).
  const column = (key: string, title: string, unit: string, group: HandoutGroup, addLabel: string | null, dated = false, node?: HandoutCourseNode) => {
    const items = inGroup(group);
    return <section className="handout-column" key={key} aria-label={labelGroup({ ...group, studentName: title })}>
      <header className="row-tail"><h2>{title}</h2>{!!items.length && <span>{items.length} {unit} · 已编 {items.filter(item => questionTotal(item) + item.sheetCounts.quiz + item.sheetCounts.homework > 0).length} {unit}</span>}{node && nodeMenu(node)}</header>
      <ol>
        {items.map((item, index) => entry(item, { index, size: items.length }, dated ? `更新于 ${shortDate(item.updatedAt)}` : undefined))}
        {addLabel && <li className="handout-entry-add"><button disabled={busy} onClick={() => create(group)}>＋ {addLabel}</button></li>}
      </ol>
    </section>;
  };

  const keyword = query.trim().toLowerCase();
  const matches = (handout: HandoutSummary) => [handout.title, ...handout.outline.map((module) => module.title)].some((text) => text.toLowerCase().includes(keyword));
  const navItem = (key: string, label: string, count: number, active: boolean, onClick: () => void, top = false) =>
    <button key={key} className={`${top ? "shelf" : "item"}${active ? " active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}><span>{label}</span>{count ? <em>{count}</em> : null}</button>;
  const all = handouts ?? [];
  const unsorted = countIn(NOWHERE);
  const viewing = keyword ? null : shelf;

  return <main className="handout-home">
    <aside className="handout-nav" aria-label="讲义书架"><div>
      <input className="handout-find" type="search" aria-label="查找讲义" placeholder="查找讲义或模块" value={query} onChange={(event) => setQuery(event.target.value)} />
      <nav>
        <div className="handout-nav-heading">{navItem("course", "课程体系", 0, false, () => choose("course"), true)}<button className="icon-button" aria-label="新建体系" title="新建体系" disabled={busy || !courseNodes} onClick={() => addNode(null, "体系")}>＋</button></div>
        {systems.map((system) => <div key={system.id}>
          <div className={`handout-nav-row row-tail${viewing === "course" && activeSystem?.id === system.id ? " current-path" : ""}`}>{navItem(system.id, system.name, all.filter((item) => coursePath(courseNodes ?? [], item.courseUnitId)[0]?.id === system.id).length, viewing === "course" && activeSystem?.id === system.id && !activeStage, () => choose("course", system.id))}{nodeMenu(system)}</div>
          {activeSystem?.id === system.id && <div className="handout-stage-nav">
            {stages.map((stage) => <div className="handout-nav-row row-tail" key={stage.id}>{navItem(stage.id, stage.name, all.filter((item) => coursePath(courseNodes ?? [], item.courseUnitId)[1]?.id === stage.id).length, viewing === "course" && activeStage?.id === stage.id, () => choose("course", stage.id))}{nodeMenu(stage)}</div>)}
            <button className="handout-outline-add" disabled={busy} onClick={() => addNode(system.id, "年级 / 阶段")}>＋ 添加年级 / 阶段</button>
          </div>}
        </div>)}
        {navItem("topic", "专题库", all.filter((item) => shelfOf(item) === "topic").length, viewing === "topic", () => choose("topic"), true)}
        {navItem("student", "学生讲义", 0, false, () => choose("student"), true)}
        {students?.map((item) => navItem(`student-${item.id}`, item.name, countIn({ ...NOWHERE, studentId: item.id }), viewing === "student" && activeStudent?.id === item.id, () => choose("student", item.id)))}
        {students && !students.length && <a className="item handout-nav-link" href="/?view=wrong-book">去学生档案建立学生</a>}
      </nav>
    </div></aside>
    <div className="handout-board">
      {handouts === null ? <p className="handout-board-note">正在读取讲义…</p>
        : keyword ? <section className="handout-column wide" aria-label="查找结果">
          <header><h2>查找“{query.trim()}”</h2><span>{all.filter(matches).length} 份</span></header>
          {all.some(matches) ? <ol>{all.filter(matches).map((item) => entry(item, null, placeLabel(item, inGroup(item).indexOf(item))))}</ol>
            : <p className="handout-board-note">没有标题或模块名包含“{query.trim()}”的讲义。</p>}
        </section>
        : shelf === "course" ? <>
          <div className="handout-course-head"><div><h1>{activeSystem?.name || "课程体系"}</h1><p>{activeStage ? `${activeStage.name} · 先写大纲，再逐讲编撰讲义` : "从一个体系名称开始，安排年级、阶段和每一讲。"}</p></div>
            {activeStage ? <button className="secondary" disabled={busy} onClick={() => addNode(activeStage.id, "学期 / 单元")}>＋ 添加学期 / 单元</button>
              : <button className="primary-button" disabled={busy} onClick={() => addNode(activeSystem?.id ?? null, activeSystem ? "年级 / 阶段" : "体系")}>{activeSystem ? "添加年级 / 阶段" : "新建体系"}</button>}
          </div>
          {activeStage && !units.length && <p className="handout-board-note">还没有学期或单元。可以添加“暑假”“基础篇”“第一单元”等，再安排每一讲。</p>}
          <div className="handout-columns course-columns">
            {units.map((unit) => column(unit.id, unit.name, "讲", { ...NOWHERE, courseUnitId: unit.id }, `添加${lessonName(countIn({ ...NOWHERE, courseUnitId: unit.id }))}`, false, unit))}
          </div>
        </>
        : shelf === "topic" ? <div className={`handout-columns topics${unsorted ? " with-unsorted" : ""}`}>
          {HANDOUT_DOMAINS.map((item) => column(item.value, item.label, "个", { ...NOWHERE, domain: item.value }, "新建专题"))}
          {!!unsorted && column("unsorted", UNSORTED_TOPIC_LABEL, "份", NOWHERE, null)}
        </div>
        : !activeStudent ? <p className="handout-board-note">{students === null ? "正在读取学生档案…" : <>还没有学生。<a href="/?view=wrong-book">去学生档案建立学生</a></>}</p>
        : <div className="handout-columns single">{column(activeStudent.id, activeStudent.name, "份", { ...NOWHERE, studentId: activeStudent.id }, `为${activeStudent.name}新建讲义`, true)}</div>}
    </div>
    {moving && (() => {
      const target = movedGroup(moving);
      const here = sameGroup(moving.handout, target);
      const ready = moving.shelf === "student" ? Boolean(moving.studentId) : moving.shelf !== "course" || coursePath(courseNodes ?? [], moving.courseUnitId).length === 3;
      const hint = here ? "已在这里。" : !ready ? "请先建立并选择目标目录或学生档案。"
        : target.studentId ? `将放到${studentName(target.studentId)}的讲义末尾，只有你能看到。`
        : target.courseUnitId ? `将成为${labelGroup(target)}的${lessonName(countIn(target))}。` : `将放到${labelGroup(target)}末尾。`;
      return <div className="modal-backdrop"><section className="modal handout-move" role="dialog" aria-modal="true" aria-label="移到">
        <div className="modal-head"><div><span className="eyebrow">移到…</span><h2>{moving.handout.title}</h2></div><button className="close" aria-label="关闭" onClick={() => setMoving(null)}>×</button></div>
        <fieldset className="handout-answer-choice"><legend>书架</legend>
          <div>{HANDOUT_SHELVES.map((item) => <label key={item.value} className={moving.shelf === item.value ? "active" : ""}><input type="radio" name="handout-move-shelf" checked={moving.shelf === item.value} onChange={() => setMoving({ ...moving, shelf: item.value })} />{item.label}</label>)}</div>
        </fieldset>
        {moving.shelf === "topic" && <fieldset className="handout-answer-choice"><legend>板块</legend>
          <div className="wrap">{HANDOUT_DOMAINS.map((item) => <label key={item.value} className={moving.domain === item.value ? "active" : ""}><input type="radio" name="handout-move-domain" checked={moving.domain === item.value} onChange={() => setMoving({ ...moving, domain: item.value })} />{item.label}</label>)}</div>
        </fieldset>}
        {moving.shelf === "course" && <label className="handout-course-field">体系 / 年级或阶段 / 学期或单元
          <select aria-label="目标课程单元" value={moving.courseUnitId} onChange={(event) => setMoving({ ...moving, courseUnitId: event.target.value })}>
            <option value="">选择学期或单元</option>
            {(courseNodes ?? []).filter((node) => coursePath(courseNodes ?? [], node.id).length === 3).map((node) => <option key={node.id} value={node.id}>{coursePath(courseNodes ?? [], node.id).map((item) => item.name).join(" / ")}</option>)}
          </select>
        </label>}
        {moving.shelf === "student" && !!students?.length && <fieldset className="handout-answer-choice"><legend>学生</legend>
          <div className="wrap">{students.map((item) => <label key={item.id} className={moving.studentId === item.id ? "active" : ""}><input type="radio" name="handout-move-student" checked={moving.studentId === item.id} onChange={() => setMoving({ ...moving, studentId: item.id })} />{item.name}</label>)}</div>
        </fieldset>}
        <p className="handout-move-hint">{hint}</p>
        <div className="modal-actions"><button className="secondary" onClick={() => setMoving(null)}>取消</button><button className="primary-button" disabled={here || !ready} onClick={() => move(moving)}>确定</button></div>
      </section></div>;
    })()}
    {outlineEdit && <div className="modal-backdrop"><form className="modal handout-move" role="dialog" aria-modal="true" aria-label={outlineEdit.id ? "重命名目录" : `新建${outlineEdit.label}`} onSubmit={(event) => { event.preventDefault(); void saveOutline(); }}>
      <div className="modal-head"><h2>{outlineEdit.id ? "重命名" : "新建"}{outlineEdit.label}</h2><button type="button" className="close" aria-label="关闭" disabled={busy} onClick={() => setOutlineEdit(null)}>×</button></div>
      <label className="handout-course-field">名称<input required maxLength={80} value={outlineEdit.name} onChange={(event) => setOutlineEdit({ ...outlineEdit, name: event.target.value, error: "" })} placeholder={outlineEdit.label === "体系" ? "例如：校内同步、竞赛提高、A Level" : "填写你自己的目录名称"} /></label>
      {outlineEdit.error && <p role="alert" className="handout-warning">{outlineEdit.error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setOutlineEdit(null)}>取消</button><button className="primary-button" disabled={busy || !outlineEdit.name.trim()}>{busy ? "正在保存…" : "保存"}</button></div>
    </form></div>}
    {confirmNode}
    {lessonDraft && <div className="modal-backdrop"><form className="modal handout-move" role="dialog" aria-modal="true" aria-label="新建一讲" onSubmit={(event) => { event.preventDefault(); void create(lessonDraft.group, undefined, { ...lessonDraft, open: false }); }}>
      <div className="modal-head"><div><h2>添加{lessonName(countIn(lessonDraft.group))}</h2><p className="handout-move-hint">{labelGroup(lessonDraft.group)}</p></div><button type="button" className="close" aria-label="关闭" disabled={busy} onClick={() => setLessonDraft(null)}>×</button></div>
      <label className="handout-course-field">本讲标题<input required maxLength={120} value={lessonDraft.title} onChange={(event) => setLessonDraft({ ...lessonDraft, title: event.target.value, error: "" })} placeholder="例如：一元一次方程" /></label>
      <label className="handout-course-field">模块大纲（选填，每行一个）<textarea rows={6} maxLength={20000} value={lessonDraft.modules} onChange={(event) => setLessonDraft({ ...lessonDraft, modules: event.target.value, error: "" })} placeholder={"方程的概念\n等式的基本性质\n一元一次方程的解法"} /></label>
      {lessonDraft.error && <p role="alert" className="handout-warning">{lessonDraft.error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setLessonDraft(null)}>取消</button><button className="secondary" disabled={busy || !lessonDraft.title.trim()}>保存大纲</button><button type="button" className="primary-button" disabled={busy || !lessonDraft.title.trim()} onClick={() => create(lessonDraft.group, undefined, { ...lessonDraft, open: true })}>保存并编写讲义</button></div>
    </form></div>}

  </main>;
}

function HandoutEditor({ id, onNotice }: { id: string; onNotice: (message: string, tone?: "success" | "error") => void }) {
  const [confirmNode, confirm] = useConfirm();
  const [doc, setDoc] = useState<Pick<Handout, "title" | "items" | "temporaryQuestions"> | null>(null);
  const [home, setHome] = useState<HandoutGroup & { studentName: string | null; coursePath: HandoutCourseNode[] }>({ ...NOWHERE, studentName: null, coursePath: [] });
  const [missing, setMissing] = useState(false);
  const [library, setLibrary] = useState<LibraryData | null>(null);
  const [bankSource, setBankSource] = useState<"library" | "temporary">("library");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  // A link from the course knowledge graph (?module=) opens the handout at that module, ready to add questions to it.
  const [focusModule] = useState(() => new URLSearchParams(window.location.search).get("module"));
  const [picker, setPicker] = useState<PickerMode | null>(() => focusModule ? { kind: "add", sectionId: focusModule, band: "example" } : null);
  // 讲义、小测、作业 share one page; the address keeps the open one, so a reload or a link lands on it.
  const [sheet, setSheet] = useState<HandoutSheet>(() => HANDOUT_SHEETS.find((item) => item.value === new URLSearchParams(window.location.search).get("sheet"))?.value ?? "handout");
  const bankPane = useRef<HTMLDivElement>(null);
  const [entry, setEntry] = useState<EntryState | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [answers, setAnswers] = useState<WordAnswerPlacement>("end");
  const [exporting, setExporting] = useState<ExportFormat | "source" | null>(null);
  const [latexStatus, setLatexStatus] = useState<LatexStatus | null>(null);
  const latest = useRef<Pick<Handout, "title" | "items" | "temporaryQuestions"> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const pending = useRef(false);
  const [noteImport, setNoteImport] = useState<string | null>(null);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const noteFile = useRef<HTMLInputElement>(null);
  const noteTarget = useRef<string | null>(null);


  useEffect(() => {
    void fetchHandout(id).then(({ handout }) => { setHome({ courseUnitId: handout.courseUnitId, coursePath: handout.coursePath, domain: handout.domain, studentId: handout.studentId, studentName: handout.studentName }); latest.current = { title: handout.title, items: ensureLeadingModule(handout.items, newId()), temporaryQuestions: handout.temporaryQuestions }; setDoc(latest.current); }).catch(() => setMissing(true));
    void fetchLibrary().then(setLibrary).catch(() => setLibrary({ scope: "public", modules: [], categories: [], questions: [] }));
  }, [id]);

  useEffect(() => {
    const params = new URLSearchParams({ id });
    if (sheet !== "handout") params.set("sheet", sheet);
    window.history.replaceState(null, "", `/tools/handouts?${params}`);
  }, [id, sheet]);

  useEffect(() => { document.title = `${doc?.title || "讲义"} · 讲义编撰 · MathPilot`; }, [doc?.title]);

  const opened = Boolean(doc);
  useEffect(() => {
    if (opened && focusModule) document.getElementById(`module-${focusModule}`)?.scrollIntoView({ block: "start" });
  }, [opened, focusModule]);

  // Unsaved text or a failed save would be lost on leaving.
  useEffect(() => {
    if (saveState === "saved") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  // Items saved before the two libraries merged may still say scope "mine"; the id alone finds the question.
  const questionIndex = useMemo(() => new Map([...(library?.questions ?? []), ...(doc?.temporaryQuestions ?? [])].map((question) => [question.id, question])), [library, doc?.temporaryQuestions]);
  const resolve = (questionId: string) => questionIndex.get(questionId);
  const libraryReady = Boolean(library);

  // One request at a time; whatever is newest when it finishes is sent next.
  function flush(): Promise<void> {
    if (saving.current) { pending.current = true; return saving.current; }
    setSaveState("saving");
    saving.current = (async () => {
      try {
        do {
          pending.current = false;
          const sent = latest.current!;
          const { handout } = await updateHandout({ id, ...sent });
          // Replace uploaded data URLs only if no newer temporary edit has superseded this save.
          if (latest.current!.temporaryQuestions === sent.temporaryQuestions) {
            latest.current = { ...latest.current!, temporaryQuestions: handout.temporaryQuestions }; setDoc(latest.current);
          }
        } while (pending.current);
        setSaveState("saved");
      } catch (error) { setSaveState("failed"); throw error; }
      finally { saving.current = null; }
    })();
    return saving.current;
  }
  function edit(next: Partial<Pick<Handout, "title" | "items" | "temporaryQuestions">>, save = true) {
    latest.current = { ...latest.current!, ...next }; setDoc(latest.current);
    if (save) void flush().catch(() => {}); else setSaveState("editing");
  }
  const setItems = (items: HandoutItem[], save = true) => edit({ items }, save);
  const updateSection = (itemId: string, changes: { title?: string; note?: string }) => setItems(latest.current!.items.map((item) => item.id === itemId && item.kind === "section" ? { ...item, ...changes } : item), false);

  function insertQuestions(questionIds: string[], sectionId: string | null, band: HandoutBand) {
    const items = latest.current!.items;
    const at = insertIndexForSection(items, sectionId);
    const added = questionIds.map((questionId): HandoutItem => ({ id: newId(), kind: "question", scope: "public", questionId, band }));
    setItems([...items.slice(0, at), ...added, ...items.slice(at)]);
  }

  // 小测 and 作业 questions join the end of their list, testing the chosen module.
  function appendToList(questionIds: string[], list: ListSheet, moduleId: string | null) {
    setItems([...latest.current!.items, ...questionIds.map((questionId): HandoutItem => ({ id: newId(), kind: list, scope: "public", questionId, moduleId }))]);
  }

  // A replacement keeps the slot: same module, same band or list, same position.
  function pick(questionIds: string[], target: PickerMode) {
    if (target.kind === "replace") {
      const [questionId] = questionIds; const itemId = target.itemId;
      setItems(latest.current!.items.map((item) => item.id === itemId && item.kind !== "section" ? { ...item, scope: "public", questionId } : item));
      onNotice("题目已替换");
    } else if (sheet === "handout") { insertQuestions(questionIds, target.sectionId, target.band); onNotice(`已加入 ${questionIds.length} 道${HANDOUT_PARTS[target.band].label}`); }
    else { appendToList(questionIds, sheet, target.sectionId); onNotice(`已加入 ${questionIds.length} 道${sheetLabel(sheet)}题`); }
    if (target.kind === "replace") setPicker(null);
  }

  // A new module follows the last one, ahead of the 小测 and 作业 lists.
  function addModule() {
    const items = latest.current!.items;
    const lists = items.findIndex((item) => item.kind === "quiz" || item.kind === "homework");
    const at = lists < 0 ? items.length : lists;
    setItems([...items.slice(0, at), { id: newId(), kind: "section", title: "", note: "" }, ...items.slice(at)]);
  }

  function openSheet(next: HandoutSheet) {
    setSheet(next); setPicker(null);
  }

  function choosePicker(mode: PickerMode) {
    setPicker(mode);
    bankPane.current?.scrollIntoView({ block: "nearest" });
  }

  function changeBand(itemId: string, band: HandoutBand) {
    setItems(setItemBand(latest.current!.items, itemId, band));
    onNotice(`已改为${HANDOUT_PARTS[band].label}`);
  }

  // 小测 and 作业 questions on the module stay in their lists and test the neighbouring module instead.
  async function removeModule(section: SectionItem, questions: QuestionItem[], name: string) {
    const tested = latest.current!.items.filter((item) => (item.kind === "quiz" || item.kind === "homework") && item.moduleId === section.id).length;
    const ask = questions.length ? `删除“${name}”及其中 ${questions.length} 道题？` : `删除“${name}”？`;
    const moved = tested ? `考查这个模块的 ${tested} 道小测、作业题会改为考查相邻模块。` : "";
    if (!await confirm({ title: `删除知识模块「${name}」`, body: `${ask}${moved}题目仍保留在题库中；讲义中的这次删除无法撤销。`, confirmLabel: "删除知识模块", danger: true })) return;
    setItems(removeHandoutModule(latest.current!.items, section.id));
  }

  function openNewEntry(sectionId: string | null, band: HandoutBand) {
    if (!library) return;
    if (!library.modules.length) { onNotice("题库还没有模块，请先到题库创建一个模块"); return; }
    const remembered = readStored(ENTRY_CATEGORY_KEY);
    const category = library.categories.find((item) => item.id === remembered);
    const targetModule = library.modules.find((item) => item.id === (category?.moduleId ?? remembered)) ?? library.modules[0];
    setEntry({ draft: newQuestionDraft(targetModule, category && category.moduleId === targetModule.id ? category.id : targetModule.id), sectionId, band, sheet });
  }

  function openEditEntry(question: Question) {
    const questionModule = library?.modules.find((item) => item.id === question.moduleId);
    setEntry({ draft: editableQuestionDraft(question, questionModule), sectionId: null, band: "example", sheet, temporary: latest.current!.temporaryQuestions.some((item) => item.id === question.id) });
  }

  function openTemporaryImport() {
    const targetModule = library?.modules[0];
    const draft: Question = targetModule ? newQuestionDraft(targetModule, targetModule.id) : { id: "", categoryId: "", type: "解答题", difficulty: "中等", stem: "", options: [], answer: "", analysis: "", source: "", createdAt: 0, updatedAt: 0 };
    setEntry({ draft, sectionId: null, band: "example", sheet, temporary: true });
  }

  async function saveTemporaryQuestions(questions: Question[]) {
    const updated = [...latest.current!.temporaryQuestions];
    for (const question of questions) {
      const index = updated.findIndex((item) => item.id === question.id);
      if (index < 0) updated.push(question); else updated[index] = question;
    }
    if (updated.length > 400) throw new Error("临时题库最多保存 400 道题，请拆分讲义");
    edit({ temporaryQuestions: updated }, false);
    await flush();
    return latest.current!.temporaryQuestions.filter((item) => questions.some((question) => question.id === item.id));
  }

  async function archiveTemporaryQuestions(ids: string[], categoryId: string) {
    const moduleId = library?.categories.find((item) => item.id === categoryId)?.moduleId ?? categoryId;
    if (!library?.modules.some((item) => item.id === moduleId)) throw new Error("请先选择正式题库的保存分类");
    const questions = latest.current!.temporaryQuestions.filter((question) => ids.includes(question.id) && !library.questions.some((item) => item.id === question.id));
    const result = await saveQuestionImportBatch(questions, async (question) => (await createCloudQuestion({ ...question, categoryId, moduleId })).question);
    const saved = result.saved.map((item) => item.question);
    setLibrary((current) => current && { ...current, questions: [...saved, ...current.questions.filter((item) => !saved.some((question) => question.id === item.id))] });
    onNotice(`已将 ${saved.length} 道题加入正式题库${result.failed.length ? `；${result.failed.length} 道失败，可重试：${result.failed[0].error}` : ""}`, result.failed.length ? "error" : "success");
    return saved.map((question) => question.id);
  }

  function entrySaved(current: EntryState, saved: Question[]) {
    if (current.temporary) return; // Already saved with this handout; choosing a lane is a separate action.
    setLibrary((value) => value && { ...value, questions: [...saved, ...value.questions.filter((item) => !saved.some((entryQuestion) => entryQuestion.id === item.id))] });
    // Editing an existing question only refreshes it; anything newly created joins the handout.
    const created = saved.filter((question) => question.id !== current.draft.id);
    if (!created.length) return;
    writeStored(ENTRY_CATEGORY_KEY, created[0].categoryId);
    if (current.sheet === "handout") insertQuestions(created.map((question) => question.id), current.sectionId, current.band);
    else appendToList(created.map((question) => question.id), current.sheet, current.sectionId);
  }

  // 知识点截图 → AI 转录成小标题、段落、要点和配图，追加到这个模块的知识点里。
  async function importNoteScreenshot(sectionId: string, file: File) {
    if (noteImport) return;
    setNoteImport(sectionId);
    try {
      const image = await readScreenshot(file);
      const result = await recognizeScreenshot<NoteRecognitionResult>("/api/recognize-note", image);
      // Every figure is cut from one analysis of the screenshot: its own strokes only, on clean white.
      const { extractNoteFigures } = await import("../../../lib/note-figures");
      const cuts = await extractNoteFigures(image, result.blocks);
      const figures = new Map<RecognizedNoteFigure, string>(); let missedFigures = 0;
      for (const block of result.blocks) {
        if (block.type !== "figures") continue;
        for (const figure of block.figures) {
          const cut = cuts.get(figure);
          try { if (!cut) throw new Error("没有裁出配图"); figures.set(figure, (await uploadHandoutImage(cut)).url); } catch { missedFigures += 1; }
        }
      }
      const text = noteFromBlocks(result.blocks, (figure) => figures.get(figure) ?? null);
      if (!text.trim()) throw new Error("截图里没有识别到知识点文字");
      setItems(latest.current!.items.map((item) => item.id === sectionId && item.kind === "section" ? { ...item, note: item.note.trim() ? `${item.note.trimEnd()}\n${text}` : text } : item));
      const checks = [...(missedFigures ? [`${missedFigures} 张配图未能裁剪`] : []), ...result.warnings.slice(0, 2)];
      onNotice(checks.length ? `已识别，请核对：${checks.join("；")}` : "已识别并加入知识点");
    } catch (error) { onNotice(error instanceof Error ? error.message : "识别失败，请重试", "error"); }
    finally { setNoteImport(null); }
  }

  function chooseNoteScreenshot(sectionId: string) { noteTarget.current = sectionId; noteFile.current?.click(); }

  // Where 精排 PDF cannot be typeset (the hosted site), the main action falls back to Word.
  const pdfReady = latexStatus?.available === true;
  const mainFormat: ExportFormat = latexStatus && !latexStatus.available ? "word" : "pdf";

  async function openExport() {
    setExportOpen(true);
    const { latexCompilerStatus } = await import("../../../lib/handout-latex-files");
    const status = await latexCompilerStatus();
    setLatexStatus(status);
  }

  // PDF and LaTeX source share one generator; Word keeps the editable source format. The open 讲义, 小测 or 作业 is exported.
  async function exportHandout(kind: ExportFormat | "source") {
    if (!doc || exporting) return;
    setExporting(kind);
    try {
      const find = (_scope: unknown, questionId: string) => resolve(questionId);
      const handout = sheet === "handout" ? handoutSections(doc.items, find) : null;
      const list = sheet === "handout" ? null : sheetQuestions(doc.items, sheet, find);
      const missingCount = (handout ?? list)!.missingCount;
      const temporaryIds = new Set(doc.temporaryQuestions.map((question) => question.id));
      const ids = [...new Set(doc.items.flatMap((item) => item.kind === (sheet === "handout" ? "question" : sheet) && resolve(item.questionId) && !temporaryIds.has(item.questionId) ? [item.questionId] : []))];
      if (ids.length) await authorizeDownload(ids);
      const notes = missingCount ? [`跳过 ${missingCount} 道无法读取的题`] : [];
      const fileName = list ? `${doc.title}-${sheetLabel(sheet)}` : doc.title;
      if (kind === "word") {
        const { buildWordBlob, handoutWordSections } = await import("../../../lib/export-word");
        const word = list ? { title: `${doc.title} · ${sheetLabel(sheet)}`, sections: [{ questions: list.questions }] } : { title: doc.title, sections: handoutWordSections(handout!.modules, answers) };
        saveBlob(await buildWordBlob({ ...word, answers }), `${fileName}.docx`);
        onNotice(["Word 已生成", ...notes].join("，"));
      } else {
        const { buildHandoutLatexProject, compileLatexPdf, latexSourceZip } = await import("../../../lib/handout-latex-files");
        const project = await buildHandoutLatexProject(list ? { title: doc.title, answers, sheet: sheetLabel(sheet), questions: list.questions } : { title: doc.title, answers, modules: handout!.modules });
        if (project.missingFigures) notes.push(`${project.missingFigures} 张配图未能读取`);
        if (kind === "source") {
          saveBlob(await latexSourceZip(project), `${fileName}-LaTeX.zip`);
          onNotice(["LaTeX 源码已下载", ...notes].join("，"));
        } else {
          const { pdf, issues } = await compileLatexPdf(project);
          saveBlob(pdf, `${fileName}.pdf`);
          setLatexStatus((status) => status && { ...status, installed: true });
          onNotice(["PDF 已生成", ...(issues ? [`${issues} 处公式需要检查`] : []), ...notes].join("，"));
        }
      }
      setExportOpen(false);
    } catch (error) { onNotice(error instanceof Error ? error.message : "导出失败", "error"); }
    finally { setExporting(null); }
  }

  if (missing) return <main className="toolbox handouts"><a className="secondary" href="/tools/handouts"><BackIcon /><span>全部讲义</span></a><div className="handout-empty"><b>讲义不存在</b><p>它可能已被删除。</p></div></main>;
  if (!doc) return <main className="toolbox handouts"><p className="handout-muted">正在读取讲义…</p></main>;

  // Questions always sit in a module (see ensureLeadingModule), so only module cards are shown.
  const modules = handoutModules(doc.items).flatMap((module) => module.section ? [{ section: module.section, bands: module.bands }] : []);
  const activePicker: PickerMode = picker?.kind === "replace" && doc.items.some((item) => item.id === picker.itemId)
    ? picker
    : { kind: "add", sectionId: picker?.kind === "add" && modules.some(({ section }) => section.id === picker.sectionId) ? picker.sectionId : modules[0]?.section.id ?? null, band: picker?.kind === "add" ? picker.band : "example" };
  const numbers = handoutNumbers(doc.items);
  const moduleOptions = modules.map(({ section }, index) => ({ id: section.id, label: `模块${moduleHeading(section.title, index).numeral} · ${section.title || "未命名模块"}` }));
  const listed = doc.items.filter((item): item is ListItem => item.kind === sheet);
  // A question goes into each of the 讲义, 小测 and 作业 at most once; the bank also marks where else in this 讲 it is used.
  const placed = doc.items.flatMap((item) => item.kind === "section" ? [] : [{ questionId: item.questionId, sheet: item.kind === "question" ? "handout" as const : item.kind }]);
  const taken = new Set(placed.filter((entry) => entry.sheet === sheet).map((entry) => entry.questionId));
  const usedIn = new Map<string, Set<string>>();
  for (const entry of placed) if (entry.sheet !== sheet) usedIn.set(entry.questionId, (usedIn.get(entry.questionId) ?? new Set<string>()).add(sheetLabel(entry.sheet)));
  const sizes = Object.fromEntries(HANDOUT_SHEETS.map((item) => [item.value, placed.filter((entry) => entry.sheet === item.value).length])) as Record<HandoutSheet, number>;
  const questionCount = sizes[sheet];
  const missingCount = libraryReady ? placed.filter((entry) => entry.sheet === sheet && !resolve(entry.questionId)).length : 0;
  const answerChoice = ANSWER_CHOICES.find((choice) => choice.value === answers);
  const saveLabel = { saved: "已保存", editing: "编辑中", saving: "保存中…", failed: "保存失败" }[saveState];
  // The back link names where this handout lives and returns to that shelf.
  const homeShelf = shelfOf(home);
  const backLabel = groupLabel(home);
  const backHref = homeShelf === "student" ? `/tools/handouts?shelf=student&student=${encodeURIComponent(home.studentId ?? "")}` : homeShelf === "course" ? `/tools/handouts?shelf=course&course=${encodeURIComponent(home.coursePath[0]?.id ?? "")}&stage=${encodeURIComponent(home.coursePath[1]?.id ?? "")}` : "/tools/handouts?shelf=topic";

  // One question as the handout prints it, with one quiet line underneath: where it comes from, its 考点 and the actions.
  // 移出讲义 stays a visible red button; the rest of the actions are plain text buttons.
  const questionCard = (item: QuestionItem, band: HandoutBand, laneIndex: number, laneSize: number) => {
    const question = resolve(item.questionId);
    const temporary = doc.temporaryQuestions.some((entry) => entry.id === item.questionId);
    const label = numbers.get(item.id) ?? ""; const name = band === "practice" ? `练习 ${label}` : label;
    const points = question ? questionPoints(question) : [];
    return <article className="handout-question" key={item.id}>
      {question ? <QuestionBody question={question} number={label} /> : <p className="handout-missing">{libraryReady ? "原题已删除或无权访问，可替换或移出。" : "正在读取题目…"}</p>}
      <div className="handout-question-foot">
        {question && library && <small>{question.type} · {temporary ? "临时题库" : categoryPath(library.modules, library.categories, question.categoryId)}</small>}
        {question && <span className="handout-points">{points.length
          ? points.map((point) => <b key={point}>{point}</b>)
          : question.canEdit ? <button className="text-button" onClick={() => openEditEntry(question)}>未标知识点 · 补充</button> : <em>未标知识点</em>}</span>}
        <div className="handout-actions">
          <button aria-label={`${name} 上移`} disabled={laneIndex === 0} onClick={() => setItems(moveHandoutItem(doc.items, item.id, -1))}>↑</button>
          <button aria-label={`${name} 下移`} disabled={laneIndex === laneSize - 1} onClick={() => setItems(moveHandoutItem(doc.items, item.id, 1))}>↓</button>
          <button disabled={!libraryReady} onClick={() => choosePicker({ kind: "replace", itemId: item.id, label: `替换 ${name}` })}>替换</button>
          <PaperMoreMenu label="题目更多操作">
            {HANDOUT_BANDS.filter((other) => other !== band).map((other) => <button key={other} onClick={() => changeBand(item.id, other)}>改为{HANDOUT_PARTS[other].label}</button>)}
            {question?.canEdit && <button onClick={() => openEditEntry(question)}>{temporary ? "编辑临时题" : "编辑原题"}</button>}
          </PaperMoreMenu>
          <button className="danger" aria-label={`${name} 移出讲义`} onClick={() => setItems(doc.items.filter((entryItem) => entryItem.id !== item.id))}>移出讲义</button>
        </div>
      </div>
    </article>;
  };

  // A 小测 or 作业 question: numbered in its list, with the module it tests in place of the 考点.
  const listCard = (item: ListItem, index: number, size: number) => {
    const question = resolve(item.questionId);
    const temporary = doc.temporaryQuestions.some((entry) => entry.id === item.questionId);
    const label = String(index + 1); const list = sheetLabel(item.kind); const name = `${list} ${label}`;
    return <article className="handout-question" key={item.id}>
      {question ? <QuestionBody question={question} number={label} /> : <p className="handout-missing">{libraryReady ? "原题已删除或无权访问，可替换或移出。" : "正在读取题目…"}</p>}
      <div className="handout-question-foot">
        {question && library && <small>{question.type} · {temporary ? "临时题库" : categoryPath(library.modules, library.categories, question.categoryId)}</small>}
        <label className="handout-tests">考查
          <select aria-label={`${name} 考查模块`} value={item.moduleId ?? ""} onChange={(event) => setItems(doc.items.map((entry) => entry.id === item.id ? { ...item, moduleId: event.target.value || null } : entry))}>
            {!item.moduleId && <option value="">未选模块</option>}
            {moduleOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <div className="handout-actions">
          <button aria-label={`${name} 上移`} disabled={index === 0} onClick={() => setItems(moveHandoutItem(doc.items, item.id, -1))}>↑</button>
          <button aria-label={`${name} 下移`} disabled={index === size - 1} onClick={() => setItems(moveHandoutItem(doc.items, item.id, 1))}>↓</button>
          <button disabled={!libraryReady} onClick={() => choosePicker({ kind: "replace", itemId: item.id, label: `替换 ${name}` })}>替换</button>
          {question?.canEdit && <PaperMoreMenu label="题目更多操作"><button onClick={() => openEditEntry(question)}>{temporary ? "编辑临时题" : "编辑原题"}</button></PaperMoreMenu>}
          <button className="danger" aria-label={`${name} 移出${list}`} onClick={() => setItems(doc.items.filter((entry) => entry.id !== item.id))}>移出{list}</button>
        </div>
      </div>
    </article>;
  };
  // The bank keeps adding to the module it last pointed at.
  const addTarget = activePicker.kind === "add" ? activePicker.sectionId : modules[0]?.section.id ?? null;

  return <main className="toolbox handouts handout-editor">
    {confirmNode}
    <header className="handout-bar">
      <a className="brand-mark" href={backHref} aria-label="返回讲义书架">题</a>
      <a className="handout-back" aria-label={`返回${backLabel}`} href={backHref}><span>讲义编撰</span><span aria-hidden="true">/</span><span>{backLabel}</span></a>
      <span className={`handout-save ${saveState}`} role="status">{saveLabel}{saveState === "failed" && <button className="text-button" onClick={() => void flush().catch(() => {})}>重试</button>}</span>
      <button className="primary-button" disabled={!questionCount || !libraryReady} onClick={() => void openExport()}>导出</button>
    </header>
    <div className="handout-workspace">
      <div className="handout-bank-pane" ref={bankPane}>
        <QuestionPicker library={library} mode={activePicker} sheet={sheet} taken={taken} usedIn={usedIn} onPick={(ids) => pick(ids, activePicker)} onModeChange={setPicker}
          source={bankSource} onSourceChange={setBankSource} temporaryQuestions={doc.temporaryQuestions} onImport={openTemporaryImport} onArchive={archiveTemporaryQuestions} onNotice={onNotice}
          onEdit={openEditEntry} onRemove={async (questionId) => {
            if (placed.some((item) => item.questionId === questionId)) { onNotice("请先从讲义、小测和作业中移出这道题，再从临时题库删除"); return; }
            if (await confirm({ title: "删除临时题", body: "从当前讲义的临时题库删除这道题，无法恢复。已保存到正式题库的内容不受影响。", confirmLabel: "删除临时题", danger: true })) edit({ temporaryQuestions: latest.current!.temporaryQuestions.filter((question) => question.id !== questionId) });
          }}
          sections={moduleOptions} />
      </div>
      <div className="handout-draft" aria-label="讲义编辑">
    <div className="handout-draft-head">
      <input className="handout-title" aria-label="讲义标题" value={doc.title} onFocus={(event) => { if (event.target.value === DEFAULT_HANDOUT_TITLE) event.target.select(); }} onChange={(event) => edit({ title: event.target.value }, false)} onBlur={() => void flush().catch(() => {})} />
      <div className="handout-sheets" role="tablist" aria-label="本讲资料">
        {HANDOUT_SHEETS.map((item) => <button key={item.value} role="tab" aria-selected={sheet === item.value} onClick={() => openSheet(item.value)}>
          {item.label}<span className={`handout-count${sizes[item.value] ? "" : " zero"}`} aria-label={`${sizes[item.value]} 道题`}>{sizes[item.value]}</span>
        </button>)}
      </div>
    </div>

    {sheet !== "handout" ? <section className="handout-list" aria-label={sheetLabel(sheet)}>
      <div className="handout-lane">
        <div className="handout-lane-head"><b>{sheetLabel(sheet)}</b><span className={`handout-count${listed.length ? "" : " zero"}`} aria-label={`${listed.length} 道题`}>{listed.length}</span>
          <div className="handout-lane-add">
            <button className="text-button" disabled={!libraryReady} onClick={() => choosePicker({ kind: "add", sectionId: addTarget, band: "example" })}>从题库选题</button>
            <button className="text-button" disabled={!libraryReady} onClick={() => openNewEntry(addTarget, "example")}>录入新题</button>
          </div>
        </div>
        {listed.map((item, index) => listCard(item, index, listed.length))}
      </div>
    </section> : <>
    {modules.map(({ section, bands }, moduleIndex) => {
      const heading = moduleHeading(section.title, moduleIndex); const badge = `模块${heading.numeral}`;
      return <section className="handout-module" key={section.id} id={`module-${section.id}`} aria-label={badge}>
        <div className="handout-module-head">
          <span className="handout-module-no" aria-hidden="true">{heading.numeral}</span>
          <input aria-label={`${badge}名称`} value={section.title} placeholder="模块名称，如：平行四边形的性质" onChange={(event) => updateSection(section.id, { title: event.target.value })} onBlur={() => void flush().catch(() => {})} />
          <PaperMoreMenu label="模块更多操作">
            {modules.length > 1 && <>
              <button disabled={moduleIndex === 0} onClick={() => setItems(moveHandoutItem(doc.items, section.id, -1))}>上移</button>
              <button disabled={moduleIndex === modules.length - 1} onClick={() => setItems(moveHandoutItem(doc.items, section.id, 1))}>下移</button>
            </>}
            <hr /><button className="danger-text" onClick={() => removeModule(section, HANDOUT_BANDS.flatMap((band) => bands[band]), heading.title || badge)}>删除模块…</button>
          </PaperMoreMenu>
        </div>

        <div className={`handout-lane knowledge${dropNote === section.id ? " dropping" : ""}`}
          onPaste={(event) => { const file = clipboardImage(event); if (file) { event.preventDefault(); void importNoteScreenshot(section.id, file); } }}
          onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDropNote(section.id); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropNote(null); }}
          onDrop={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDropNote(null); const file = droppedImage(event); if (file) void importNoteScreenshot(section.id, file); else onNotice("请选择图片文件"); }}>
          <div className="handout-lane-head"><b>{HANDOUT_PARTS.knowledge.label}</b>
            {dropNote === section.id ? <em>松开即可识别截图</em> : <button className="text-button" title="选择、拖入或粘贴知识点截图" disabled={Boolean(noteImport)} onClick={() => chooseNoteScreenshot(section.id)}>{noteImport === section.id ? "正在识别截图…" : "截图识别"}</button>}
          </div>
          <Suspense fallback={<div className="note-editor"><div className="note-editor-body"><NotePreview note={section.note} /></div></div>}>
            <NoteEditor value={section.note} label={`${badge}知识点`} placeholder={HANDOUT_PARTS.knowledge.hint} onChange={(note) => updateSection(section.id, { note })} onCommit={() => void flush().catch(() => {})} />
          </Suspense>
        </div>

        {HANDOUT_BANDS.map((band) => {
          const lane = bands[band];
          // The lane the bank is adding to is marked, so it is always clear where picked questions go.
          const target = activePicker.kind === "add" && activePicker.sectionId === section.id && activePicker.band === band;
          return <div className={`handout-lane ${band}${target ? " target" : ""}`} key={band}>
            <div className="handout-lane-head"><b>{HANDOUT_PARTS[band].label}</b><span className={`handout-count${lane.length ? "" : " zero"}`} aria-label={`${lane.length} 道题`}>{lane.length}</span>
              <div className="handout-lane-add">
                <button className="text-button" aria-pressed={target} disabled={!libraryReady} onClick={() => choosePicker({ kind: "add", sectionId: section.id, band })}>从题库选题</button>
                <button className="text-button" disabled={!libraryReady} onClick={() => openNewEntry(section.id, band)}>录入新题</button>
              </div>
            </div>
            {lane.map((item, laneIndex) => questionCard(item, band, laneIndex, lane.length))}
          </div>;
        })}
      </section>;
    })}
    <button className="handout-add-section" onClick={addModule}>＋ 添加知识模块</button>
    </>}

      </div>
    </div>

    <input ref={noteFile} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file && noteTarget.current) void importNoteScreenshot(noteTarget.current, file); event.target.value = ""; }} />
    {entry && library && <QuestionEntry initial={entry.draft} modules={library.modules} categories={library.categories}
      moduleIds={entry.draft.id && !entry.temporary ? [entry.draft.moduleId ?? ""] : library.modules.map((item) => item.id)}
      saveTemporaryQuestions={entry.temporary ? saveTemporaryQuestions : undefined} startWithFile={entry.temporary && !entry.draft.id}
      onSaved={(saved) => entrySaved(entry, saved)} onClose={() => setEntry(null)} onNotice={onNotice} />}
    {exportOpen && <div className="modal-backdrop"><section className="modal export-modal" role="dialog" aria-modal="true" aria-label="导出讲义">
      <div className="modal-head"><div><span className="eyebrow">导出{sheet === "handout" ? "" : sheetLabel(sheet)} · {questionCount} 题</span><h2>{doc.title}</h2></div><button className="close" aria-label="关闭" disabled={Boolean(exporting)} onClick={() => setExportOpen(false)}>×</button></div>
      <fieldset className="handout-answer-choice" disabled={Boolean(exporting)}><legend>答案</legend>
        <div>{ANSWER_CHOICES.map((choice) => <label key={choice.value} className={answers === choice.value ? "active" : ""}><input type="radio" name="handout-answers" value={choice.value} checked={answers === choice.value} onChange={() => setAnswers(choice.value)} />{choice.label}</label>)}</div>
        <p>{sheet === "handout" ? answerChoice?.hint : answerChoice?.listHint}</p>
      </fieldset>
      {!!missingCount && <p className="handout-warning">有 {missingCount} 道题已无法读取，导出时会跳过。</p>}
      {latexStatus && !latexStatus.available ? <p className="handout-export-status">精排 PDF 需要在运行 MathPilot 的这台电脑上生成；这里可以导出 Word，或下载 LaTeX 源码自行编译。</p>
        : latexStatus && !latexStatus.installed && <p className="handout-export-status">首次生成会下载排版组件（约 25MB）和所需宏包，约 1–2 分钟，之后几秒完成。</p>}
      {/* PDF is the handout; Word and the LaTeX source are kept for the rare file someone else needs. */}
      <div className="modal-actions handout-export-actions">
        <details className="handout-more-formats" onToggle={(event) => closeOutside(event.currentTarget)}>
          <summary>其他格式</summary>
          <div role="menu">
            {pdfReady && <button role="menuitem" disabled={Boolean(exporting)} onClick={(event) => { closeMenu(event.currentTarget); void exportHandout("word"); }}>{exporting === "word" ? "正在生成…" : "导出 Word"}</button>}
            <button role="menuitem" disabled={Boolean(exporting)} onClick={(event) => { closeMenu(event.currentTarget); void exportHandout("source"); }}>{exporting === "source" ? "正在打包…" : "下载 LaTeX 源码"}</button>
          </div>
        </details>
        <button className="primary-button" disabled={Boolean(exporting) || !latexStatus} onClick={() => void exportHandout(mainFormat)}>{exporting === mainFormat ? mainFormat === "pdf" ? latexStatus?.installed ? "正在排版…" : "首次排版中…" : "正在生成…" : mainFormat === "pdf" ? "生成 PDF" : "生成 Word"}</button>
      </div>
    </section></div>}
  </main>;
}
