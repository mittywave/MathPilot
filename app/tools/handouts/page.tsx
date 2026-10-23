"use client";
import { type DragEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { arrangeHandouts, authorizeDownload, createHandout, deleteHandout, fetchHandout, fetchHandouts, fetchLibrary, fetchMe, fetchStudents, loginPath, saveHandoutCourse, deleteHandoutCourse, updateHandout, uploadHandoutImage } from "../../../lib/api-client";
import { DEFAULT_HANDOUT_TITLE, HANDOUT_BANDS, HANDOUT_TOPIC_ROOT, HANDOUT_LIMITS, HANDOUT_PARTS, HANDOUT_SHEETS, HANDOUT_SHELVES, UNSORTED_TOPIC_LABEL, copyHandoutItems, coursePath, ensureLeadingModule, groupLabel, handoutModules, handoutNumbers, handoutSections, dropHandoutItem, insertIndexForSection, moduleHeading, moveHandoutItem, questionPoints, removeHandoutModule, sameGroup, setItemBand, sheetLabel, sheetQuestions, shelfOf } from "../../../lib/handout-rules.mjs";
import { categoryPath } from "../../../lib/library-tree";
import { noteFromBlocks, type RecognizedNoteFigure } from "../../../lib/handout-note.mjs";
import { clipboardImage } from "../../../lib/image-tools";
import { randomClientId } from "../../../lib/client-random-id.mjs";
import { droppedImage, readScreenshot, recognizeScreenshot } from "../../../lib/screenshot-recognition";
import type { NoteRecognitionResult } from "../../../lib/recognition-contract";
import type { AuthUser, Handout, HandoutBand, HandoutDomain, HandoutCourseNode, HandoutGroup, HandoutItem, HandoutSheet, HandoutShelf, HandoutSummary, LibraryData, Question, StudentSummary, TypesetSettings } from "../../../lib/types";
import type { BasketTypeset } from "../typeset/Typesetter";
import { PaperMoreMenu } from "../../components/PaperMoreMenu";
import { useDirectoryDrag, type DirectoryDrop } from "../../components/CategoryTree";
import { QuestionBody, SheetQuestion } from "../../components/QuestionBody";
import { editableQuestionDraft, newQuestionDraft, QuestionEntry } from "../../components/QuestionEntry";
import { BrandWordmark, SiteHeader } from "../../components/SiteHeader";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { QuestionPicker, type PickerMode } from "./QuestionPicker";
import { QuestionWorkspace, useQuestionWorkspace } from "./QuestionWorkspace";
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

const ENTRY_CATEGORY_KEY = "mitty-handout-entry-category";
// The editor engine loads with the first module; until then the note shows as it reads.
const NoteEditor = lazy(() => import("../../components/NoteEditor"));
const Typesetter = lazy(() => import("../typeset/Typesetter"));
// crypto.randomUUID only exists on secure origins; colleagues use the plain-http LAN address.
const newId = () => randomClientId();

function BackIcon() {
  return <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m10 5-7 7 7 7M3 12h18" /></svg>;
}

function GripIcon() {
  return <svg viewBox="0 0 10 16" aria-hidden="true" focusable="false">{[3, 8, 13].flatMap((y) => [2.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" />))}</svg>;
}

function readStored(key: string) { try { return window.localStorage.getItem(key) ?? ""; } catch { return ""; } }
function writeStored(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* 浏览器禁用本地存储时只是不记住上次的分类 */ } }

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
  if (!user) return <><SiteHeader active="handouts" user={null} /><main className="toolbox handouts"><p>请先登录 MathPilot。</p><a href={loginPath("/tools/handouts")}>去登录</a></main></>;
  return <>
    {openId ? <HandoutEditor id={openId} user={user} onNotice={onNotice} /> : <><SiteHeader active="handouts" user={user} /><HandoutList isAdmin={user.role === "admin"} onNotice={onNotice} /></>}
    {toastNode}
  </>;
}

const SHELF_KEY = "mitty-handout-shelf";
const COURSE_KEY = "mitty-handout-course";
const STAGE_KEY = "mitty-handout-stage";
const TOPIC_KEY = "mitty-handout-topic";
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

// Public systems and topics are shared; only administrators see and manage private systems.
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
  const [courseOpen, setCourseOpen] = useState(true);
  const [stageId, setStageId] = useState(() => link.get("stage") || (link.get("grade") ? `course-grade-${link.get("grade")}` : readStored(STAGE_KEY)));
  const [topicId, setTopicId] = useState(() => link.get("topic") || readStored(TOPIC_KEY));
  const [outlineEdit, setOutlineEdit] = useState<{ id?: string; parentId: string | null; name: string; label: string; error: string } | null>(null);
  const [lessonDraft, setLessonDraft] = useState<{ group: HandoutGroup; number: string; title: string; modules: string; error: string } | null>(null);
  const systems = (courseNodes ?? []).filter((node) => !node.parentId && node.id !== HANDOUT_TOPIC_ROOT);
  const topics = (courseNodes ?? []).filter((node) => node.parentId === HANDOUT_TOPIC_ROOT);
  const selectedTopicPath = coursePath(courseNodes ?? [], topicId);
  const activeTopic = topics.find((node) => node.id === (selectedTopicPath[1]?.id ?? topicId)) ?? (topicId === "unsorted" ? undefined : topics[0]);
  const outlines = (courseNodes ?? []).filter((node) => node.parentId === activeTopic?.id);
  const activeOutline = outlines.find((node) => node.id === selectedTopicPath[2]?.id);
  const topicGroups = (courseNodes ?? []).filter((node) => node.parentId === activeOutline?.id);
  const activeSystem = systems.find((node) => node.id === courseId) ?? systems[0];
  const stages = (courseNodes ?? []).filter((node) => node.parentId === activeSystem?.id);
  const activeStage = stages.find((node) => node.id === stageId) ?? stages[0];
  const units = (courseNodes ?? []).filter((node) => node.parentId === activeStage?.id);
  const labelGroup = (group: HandoutGroup & { studentName?: string | null }) => groupLabel({ ...group, coursePath: coursePath(courseNodes ?? [], group.courseUnitId ?? group.domain) });
  const [studentId, setStudentId] = useState(() => (linkShelf === "student" && link.get("student")) || readStored(STUDENT_KEY));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<MoveState | null>(null);
  const activeStudent = students?.find((item) => item.id === studentId) ?? students?.[0] ?? null;
  const systemDragProps = useDirectoryDrag({ modules: systems, categories: [], enabled: !busy && systems.length > 1, rowSelector: ".handout-nav-row > .item", onDrop: (drop) => { void arrangeSystems(drop); } });

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
    writeStored(TOPIC_KEY, activeOutline?.id ?? activeTopic?.id ?? "unsorted");
    if (activeStudent) writeStored(STUDENT_KEY, activeStudent.id);
    const params = new URLSearchParams({ shelf });
    if (shelf === "course" && activeSystem) {
      params.set("course", activeSystem.id);
      if (activeStage) params.set("stage", activeStage.id);
    } else if (shelf === "topic") params.set("topic", activeOutline?.id ?? activeTopic?.id ?? "unsorted");
    else if (shelf === "student" && activeStudent) params.set("student", activeStudent.id);
    window.history.replaceState(null, "", `/tools/handouts?${params}`);
  }, [shelf, courseNodes, activeSystem, activeStage, activeTopic, activeOutline, activeStudent]);

  function choose(next: HandoutShelf, value?: string) {
    if (next === "course") {
      if (value && value === activeSystem?.id && shelf === "course" && !query.trim()) {
        setCourseOpen((open) => !open); return;
      }
      setCourseOpen(true);
    }
    setShelf(next); setQuery("");
    if (next === "course" && value) {
      const node = courseNodes?.find((item) => item.id === value);
      if (node?.parentId) { setCourseId(node.parentId); setStageId(node.id); }
      else { setCourseId(value); if (value !== activeSystem?.id) setStageId(""); }
    }
    if (next === "student" && value) setStudentId(value);
    if (next === "topic" && value) setTopicId(value);
  }

  async function saveOutline() {
    if (!outlineEdit || busy) return;
    setBusy(true);
    try {
      const result = await saveHandoutCourse({ id: outlineEdit.id, parentId: outlineEdit.parentId, name: outlineEdit.name });
      setCourseNodes(result.courseNodes); setOutlineEdit(null); setQuery("");
      const path = coursePath(result.courseNodes, result.id);
      if (path[0]?.id === HANDOUT_TOPIC_ROOT) {
        setShelf("topic"); setTopicId(path[2]?.id ?? path[1].id); onNotice(path.length === 4 ? "专题已保存" : path.length === 3 ? "大纲目录已保存" : "专题分类已保存");
      } else {
        setShelf("course"); setCourseOpen(true);
        setCourseId(path[0].id); setStageId(path[1]?.id ?? "");
        onNotice("大纲已保存");
      }
    } catch (error) { setOutlineEdit({ ...outlineEdit, error: error instanceof Error ? error.message : "大纲保存失败" }); }
    finally { setBusy(false); }
  }

  async function changeNode(node: HandoutCourseNode, direction?: -1 | 1) {
    if (busy) return;
    const deletedIds = new Set((courseNodes ?? []).filter((item) => coursePath(courseNodes ?? [], item.id).some((parent) => parent.id === node.id)).map((item) => item.id));
    if (!direction && !await confirm({ title: `删除目录「${node.name}」`,
      items: [`此目录及 ${deletedIds.size - 1} 个下级目录`, `${(handouts ?? []).filter((item) => deletedIds.has(item.courseUnitId ?? item.domain ?? "")).length} 份讲义（含小测、作业和临时题库）`],
      body: "以上内容会一起删除，无法恢复。已存入正式题库的题不受影响。", confirmLabel: "删除目录", danger: true })) return;
    setBusy(true);
    try {
      const result = direction ? await saveHandoutCourse({ id: node.id, direction }) : await deleteHandoutCourse(node.id);
      if (!direction && node.id === activeOutline?.id) setTopicId(node.parentId ?? "");
      if (!direction) setHandouts((current) => current?.filter((item) => !deletedIds.has(item.courseUnitId ?? item.domain ?? "")) ?? null);
      setCourseNodes(result.courseNodes); onNotice(direction ? "顺序已调整" : "目录已删除");
    } catch (error) { onNotice(error instanceof Error ? error.message : "大纲调整失败", "error"); }
    finally { setBusy(false); }
  }

  async function arrangeSystems({ id, targetId, position }: DirectoryDrop) {
    if (busy || !courseNodes || position === "inside") return;
    const from = systems.findIndex((node) => node.id === id);
    const ordered = systems.filter((node) => node.id !== id);
    const target = ordered.findIndex((node) => node.id === targetId);
    if (from < 0 || target < 0) return;
    const to = target + (position === "after" ? 1 : 0);
    if (from === to) return;
    ordered.splice(to, 0, systems[from]);
    const before = courseNodes;
    const positions = new Map(ordered.map((node, index) => [node.id, index]));
    // Pin the current view even when it was using the first-system fallback.
    setCourseId(activeSystem?.id ?? ""); setStageId(activeStage?.id ?? "");
    setBusy(true);
    setCourseNodes(before.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)));
    try {
      const result = await saveHandoutCourse({ id, direction: to - from });
      setCourseNodes(result.courseNodes); onNotice("体系顺序已保存");
    } catch (error) { setCourseNodes(before); onNotice(error instanceof Error ? error.message : "体系排序保存失败", "error"); }
    finally { setBusy(false); }
  }

  async function changeVisibility(node: HandoutCourseNode) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await saveHandoutCourse({ id: node.id, isPrivate: !node.isPrivate });
      setCourseNodes(result.courseNodes);
      onNotice(node.isPrivate ? "体系已设为公开" : "体系已设为私密，仅管理员可见");
    } catch (error) { onNotice(error instanceof Error ? error.message : "体系可见性保存失败", "error"); }
    finally { setBusy(false); }
  }

  const nodeMenu = (node: HandoutCourseNode) => {
    const siblings = (courseNodes ?? []).filter((item) => item.parentId === node.parentId && item.id !== HANDOUT_TOPIC_ROOT);
    const index = siblings.findIndex((item) => item.id === node.id);
    return <PaperMoreMenu label={`${node.name} 目录操作`} portal>
      <button disabled={busy} onClick={() => setOutlineEdit({ id: node.id, parentId: node.parentId, name: node.name, label: "目录", error: "" })}>重命名</button>
      <button disabled={busy || index === 0} onClick={() => changeNode(node, -1)}>上移</button>
      <button disabled={busy || index === siblings.length - 1} onClick={() => changeNode(node, 1)}>下移</button>
      {isAdmin && !node.parentId && <button disabled={busy} onClick={() => changeVisibility(node)}>{node.isPrivate ? "设为公开" : "设为私密"}</button>}
      {isAdmin && <><hr /><button disabled={busy} className="danger-text" onClick={() => changeNode(node)}>删除目录…</button></>}
    </PaperMoreMenu>;
  };
  const addNode = (parentId: string | null, label: string) => setOutlineEdit({ parentId, label, name: "", error: "" });

  // The server lists by position, so every group is already in order.
  const inGroup = (group: HandoutGroup) => (handouts ?? []).filter((item) => sameGroup(item, group));
  const countIn = (group: HandoutGroup) => inGroup(group).length;
  const nextPosition = (group: HandoutGroup) => inGroup(group).reduce((next, item) => Math.max(next, item.position + 1), 0);
  const studentName = (id: string | null) => students?.find((item) => item.id === id)?.name ?? "";
  // 初一暑假 第1讲 / 几何专题 / 某某
  const placeLabel = (group: HandoutGroup & { studentName?: string | null }, index: number) =>
    group.studentId ? group.studentName || studentName(group.studentId) : group.courseUnitId || coursePath(courseNodes ?? [], group.domain).length >= 3 ? `${labelGroup(group)} ${lessonName(index)}` : labelGroup(group);

  // Outlines choose their lesson number; copies append to the original group.
  async function create(group: HandoutGroup, source?: HandoutSummary, outline?: { number: string; title: string; modules: string; open: boolean }) {
    if (busy) return;
    if ((group.courseUnitId || coursePath(courseNodes ?? [], group.domain).length >= 3) && !source && !outline) { setLessonDraft({ group, number: String(nextPosition(group) + 1), title: "", modules: "", error: "" }); return; }
    const position = outline ? Number(outline.number) - 1 : undefined;
    if (position !== undefined && (!Number.isSafeInteger(position) || position < 0 || position >= Number.MAX_SAFE_INTEGER)) {
      setLessonDraft((current) => current && { ...current, error: "讲次请填写正整数" }); return;
    }
    if (position !== undefined && inGroup(group).some((item) => item.position === position)) {
      setLessonDraft((current) => current && { ...current, error: `${lessonName(position)}已存在，请填写其他讲次` }); return;
    }
    const moduleTitles = (outline?.modules ?? "").split("\n").map((title) => title.trim()).filter(Boolean);
    if (outline && (moduleTitles.length > HANDOUT_LIMITS.items || moduleTitles.some((title) => title.length > HANDOUT_LIMITS.sectionTitle))) {
      setLessonDraft((current) => current && { ...current, error: `每讲最多 ${HANDOUT_LIMITS.items} 个模块，每个模块名最多 ${HANDOUT_LIMITS.sectionTitle} 字` }); return;
    }
    setBusy(true);
    try {
      const draft = source ? (await fetchHandout(source.id)).handout : null;
      const { handout } = await createHandout(draft
        ? { title: `${draft.title}（副本）`, items: copyHandoutItems(draft.items, newId), temporaryQuestions: draft.temporaryQuestions, ...group }
        : { title: outline?.title.trim() || DEFAULT_HANDOUT_TITLE, items: moduleTitles.map((title) => ({ id: newId(), kind: "section" as const, title, note: "" })), position, ...group });
      if (outline && !outline.open) {
        setHandouts((current) => [...(current ?? []), { ...handout, outline: handout.items.filter((item) => item.kind === "section").map((item) => ({ title: item.title, questionIds: [] })), sheetCounts: { quiz: 0, homework: 0 } }].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt));
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
    const positions = inGroup(group).filter((item) => ids.includes(item.id)).map((item) => item.position);
    let next = nextPosition(group);
    const position = new Map(ids.map((id, index) => [id, positions[index] ?? next++]));
    const name = group.studentId ? studentName(group.studentId) : null;
    setHandouts((current) => current && current.map((item) => position.has(item.id) ? { ...item, ...group, coursePath: coursePath(courseNodes ?? [], group.courseUnitId ?? group.domain), domainName: courseNodes?.find((node) => node.id === group.domain)?.name ?? null, studentName: name, position: position.get(item.id)! } : item)
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
    void arrange(group, ids, group.courseUnitId ? `已调到${lessonName(inGroup(group)[to].position)}` : "已调整顺序");
  }

  function openMove(handout: HandoutSummary) {
    const from = shelfOf(handout);
    setMoving({ handout, shelf: from, courseUnitId: handout.courseUnitId ?? units[0]?.id ?? "", domain: handout.domain && coursePath(courseNodes ?? [], handout.domain).length === 4 ? handout.domain : topicGroups[0]?.id ?? "", studentId: handout.studentId ?? activeStudent?.id ?? "" });
  }

  function move(state: MoveState) {
    const group = movedGroup(state);
    setMoving(null);
    if (sameGroup(state.handout, group)) return;
    const ids = [...inGroup(group).map((item) => item.id), state.handout.id];
    void arrange(group, ids, `已移到${placeLabel(group, nextPosition(group))}`);
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
    const numbered = Boolean(order && (handout.courseUnitId || coursePath(courseNodes ?? [], handout.domain).length >= 3) && !place);
    return <li className="handout-entry row-tail" key={handout.id}>
      <a className={numbered ? "numbered" : undefined} aria-label={`${handout.title}，${HANDOUT_SHEETS.map((sheet, index) => `${sheet.label} ${counts[index]} 题`).join("，")}`} href={`/tools/handouts?id=${encodeURIComponent(handout.id)}`}>
        {numbered ? <span className="handout-entry-no" aria-label={lessonName(handout.position)}>{handout.position + 1}</span> : null}
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
  const navItem = (key: string, label: string, count: number, active: boolean, onClick: () => void, top = false, expanded?: boolean, isPrivate = false) =>
    <button key={key} className={`${top ? "shelf" : "item"}${active ? " active" : ""}`} aria-current={active ? "page" : undefined} aria-expanded={expanded} aria-controls={expanded === undefined ? undefined : `handout-stages-${key}`} onClick={onClick}><span>{label}</span>{isPrivate && <small title="仅管理员可见">私密</small>}{count ? <em>{count}</em> : null}</button>;
  const all = handouts ?? [];
  const unsorted = countIn(NOWHERE);
  const viewing = keyword ? null : shelf;

  return <main className="handout-home">
    <aside className="handout-nav" aria-label="讲义书架"><div>
      <input className="handout-find" type="search" aria-label="查找讲义" placeholder="查找讲义或模块" value={query} onChange={(event) => setQuery(event.target.value)} />
      <nav>
        <div className="handout-nav-heading">{navItem("course", "课程体系", 0, false, () => choose("course"), true)}<button className="icon-button" aria-label="新建体系" title="新建体系" disabled={busy || !courseNodes} onClick={() => addNode(null, "体系")}>＋</button></div>
        {systems.map((system) => {
          const open = courseOpen && activeSystem?.id === system.id;
          return <div key={system.id} {...systemDragProps(system.id)}>
            <div className={`handout-nav-row row-tail${viewing === "course" && activeSystem?.id === system.id ? " current-path" : ""}`}>{navItem(system.id, system.name, all.filter((item) => coursePath(courseNodes ?? [], item.courseUnitId)[0]?.id === system.id).length, viewing === "course" && activeSystem?.id === system.id && !activeStage, () => choose("course", system.id), false, open, system.isPrivate)}{nodeMenu(system)}</div>
            <div id={`handout-stages-${system.id}`} className="tree-children" data-open={open} inert={!open} aria-hidden={!open}><div className="tree-children-content"><div className="handout-stage-nav">
              {(courseNodes ?? []).filter((node) => node.parentId === system.id).map((stage) => <div className="handout-nav-row row-tail" key={stage.id}>{navItem(stage.id, stage.name, all.filter((item) => coursePath(courseNodes ?? [], item.courseUnitId)[1]?.id === stage.id).length, viewing === "course" && activeSystem?.id === system.id && activeStage?.id === stage.id, () => choose("course", stage.id))}{nodeMenu(stage)}</div>)}
              <button className="handout-outline-add" disabled={busy} onClick={() => addNode(system.id, "年级 / 阶段")}>＋ 添加年级 / 阶段</button>
            </div></div></div>
          </div>;
        })}
        <div className="handout-nav-heading">{navItem("topic", "专题库", 0, false, () => choose("topic"), true)}<button className="icon-button" aria-label="新建专题分类" title="新建专题分类" disabled={busy || !courseNodes} onClick={() => addNode(HANDOUT_TOPIC_ROOT, "专题分类")}>＋</button></div>
        {topics.map((topic) => <div key={topic.id}>
          <div className={`handout-nav-row row-tail${viewing === "topic" && activeTopic?.id === topic.id ? " current-path" : ""}`}>{navItem(topic.id, topic.name, all.filter((item) => coursePath(courseNodes ?? [], item.domain)[1]?.id === topic.id).length, viewing === "topic" && activeTopic?.id === topic.id && !activeOutline, () => choose("topic", topic.id))}{nodeMenu(topic)}</div>
          {activeTopic?.id === topic.id && <div className="handout-stage-nav">
            {outlines.map((outline) => <div className="handout-nav-row row-tail" key={outline.id}>{navItem(outline.id, outline.name, all.filter((item) => coursePath(courseNodes ?? [], item.domain)[2]?.id === outline.id).length, viewing === "topic" && activeOutline?.id === outline.id, () => choose("topic", outline.id))}{nodeMenu(outline)}</div>)}
            <button className="handout-outline-add" disabled={busy} onClick={() => addNode(topic.id, "大纲目录")}>＋ 添加大纲目录</button>
          </div>}
        </div>)}
        {!!unsorted && navItem("unsorted", UNSORTED_TOPIC_LABEL, unsorted, viewing === "topic" && !activeTopic, () => choose("topic", "unsorted"))}
        {navItem("student", "学生讲义", 0, false, () => choose("student"), true)}
        {students?.map((item) => navItem(`student-${item.id}`, item.name, countIn({ ...NOWHERE, studentId: item.id }), viewing === "student" && activeStudent?.id === item.id, () => choose("student", item.id)))}
        {students && !students.length && <a className="item handout-nav-link" href="/library?view=wrong-book">去学生档案建立学生</a>}
      </nav>
    </div></aside>
    <div className="handout-board">
      {handouts === null ? <p className="handout-board-note">正在读取讲义…</p>
        : keyword ? <section className="handout-column wide" aria-label="查找结果">
          <header><h2>查找“{query.trim()}”</h2><span>{all.filter(matches).length} 份</span></header>
          {all.some(matches) ? <ol>{all.filter(matches).map((item) => entry(item, null, placeLabel(item, item.position)))}</ol>
            : <p className="handout-board-note">没有标题或模块名包含“{query.trim()}”的讲义。</p>}
        </section>
        : shelf === "course" ? <>
          <div className="handout-course-head"><div><h1>{activeSystem?.name || "课程体系"}</h1><p>{activeStage ? `${activeStage.name} · 先写大纲，再逐讲编撰讲义` : "从一个体系名称开始，安排年级、阶段和每一讲。"}</p></div>
            {activeStage ? <button className="secondary" disabled={busy} onClick={() => addNode(activeStage.id, "学期 / 单元")}>＋ 添加学期 / 单元</button>
              : <button className="primary-button" disabled={busy} onClick={() => addNode(activeSystem?.id ?? null, activeSystem ? "年级 / 阶段" : "体系")}>{activeSystem ? "添加年级 / 阶段" : "新建体系"}</button>}
          </div>
          {activeStage && !units.length && <p className="handout-board-note">还没有学期或单元。可以添加“暑假”“基础篇”“第一单元”等，再安排每一讲。</p>}
          <div className="handout-columns course-columns">
            {units.map((unit) => column(unit.id, unit.name, "讲", { ...NOWHERE, courseUnitId: unit.id }, "添加讲次", false, unit))}
          </div>
        </>
        : shelf === "topic" ? activeTopic ? <>
          <div className="handout-course-head"><div><h1>{activeTopic.name}</h1><p>{activeOutline ? `${activeOutline.name} · 按专题编排讲义` : "从左侧选择大纲目录，或添加新的目录。"}</p></div>
            {activeOutline ? <button className="secondary" disabled={busy} onClick={() => addNode(activeOutline.id, "专题")}>＋ 添加专题</button>
              : <button className="primary-button" disabled={busy} onClick={() => addNode(activeTopic.id, "大纲目录")}>添加大纲目录</button>}
          </div>
          {activeOutline && !topicGroups.length && <p className="handout-board-note">这个目录还没有专题。添加专题分组后，就可以分别安排讲义。</p>}
          <div className="handout-columns course-columns">
            {topicGroups.map((item) => column(item.id, item.name, "讲", { ...NOWHERE, domain: item.id }, "添加讲次", false, item))}
            {activeOutline ? !!countIn({ ...NOWHERE, domain: activeOutline.id }) && column(`${activeOutline.id}-unsorted`, "未分专题", "份", { ...NOWHERE, domain: activeOutline.id }, null)
              : !!countIn({ ...NOWHERE, domain: activeTopic.id }) && column(`${activeTopic.id}-unsorted`, "未分目录", "份", { ...NOWHERE, domain: activeTopic.id }, null)}
          </div>
        </> : unsorted ? <div className="handout-columns single">{column("unsorted", UNSORTED_TOPIC_LABEL, "份", NOWHERE, null)}</div>
          : <p className="handout-board-note">还没有专题分类，点击左侧“专题库”旁的 ＋ 创建。</p>
        : !activeStudent ? <p className="handout-board-note">{students === null ? "正在读取学生档案…" : <>还没有学生。<a href="/library?view=wrong-book">去学生档案建立学生</a></>}</p>
        : <div className="handout-columns single">{column(activeStudent.id, activeStudent.name, "份", { ...NOWHERE, studentId: activeStudent.id }, `为${activeStudent.name}新建讲义`, true)}</div>}
    </div>
    {moving && (() => {
      const target = movedGroup(moving);
      const here = sameGroup(moving.handout, target);
      const targetPath = coursePath(courseNodes ?? [], moving.shelf === "topic" ? moving.domain : moving.courseUnitId);
      const ready = moving.shelf === "student" ? Boolean(moving.studentId) : targetPath.length === (moving.shelf === "topic" ? 4 : 3) && (moving.shelf === "topic" ? targetPath[0].id === HANDOUT_TOPIC_ROOT : targetPath[0].id !== HANDOUT_TOPIC_ROOT);
      const hint = here ? "已在这里。" : !ready ? "请先建立并选择目标目录或学生档案。"
        : target.studentId ? `将放到${studentName(target.studentId)}的讲义末尾，只有你能看到。`
        : target.courseUnitId ? `将成为${labelGroup(target)}的${lessonName(nextPosition(target))}。` : `将放到${labelGroup(target)}末尾。`;
      return <div className="modal-backdrop"><section className="modal handout-move" role="dialog" aria-modal="true" aria-label="移到">
        <div className="modal-head"><div><span className="eyebrow">移到…</span><h2>{moving.handout.title}</h2></div><button className="close" aria-label="关闭" onClick={() => setMoving(null)}>×</button></div>
        <fieldset className="handout-answer-choice"><legend>书架</legend>
          <div>{HANDOUT_SHELVES.map((item) => <label key={item.value} className={moving.shelf === item.value ? "active" : ""}><input type="radio" name="handout-move-shelf" checked={moving.shelf === item.value} onChange={() => setMoving({ ...moving, shelf: item.value })} />{item.label}</label>)}</div>
        </fieldset>
        {moving.shelf === "topic" && <label className="handout-course-field">专题分类 / 大纲目录 / 专题
          <select aria-label="目标专题分组" value={moving.domain} onChange={(event) => setMoving({ ...moving, domain: event.target.value })}>
            <option value="">选择专题分组</option>
            {(courseNodes ?? []).filter((node) => { const path = coursePath(courseNodes ?? [], node.id); return path.length === 4 && path[0].id === HANDOUT_TOPIC_ROOT; }).map((node) => <option key={node.id} value={node.id}>{coursePath(courseNodes ?? [], node.id).slice(1).map((item) => item.name).join(" / ")}</option>)}
          </select>
        </label>}
        {moving.shelf === "course" && <label className="handout-course-field">体系 / 年级或阶段 / 学期或单元
          <select aria-label="目标课程单元" value={moving.courseUnitId} onChange={(event) => setMoving({ ...moving, courseUnitId: event.target.value })}>
            <option value="">选择学期或单元</option>
            {(courseNodes ?? []).filter((node) => { const path = coursePath(courseNodes ?? [], node.id); return path.length === 3 && path[0].id !== HANDOUT_TOPIC_ROOT; }).map((node) => <option key={node.id} value={node.id}>{coursePath(courseNodes ?? [], node.id).map((item) => item.name).join(" / ")}</option>)}
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
      <label className="handout-course-field">名称<input required maxLength={80} value={outlineEdit.name} onChange={(event) => setOutlineEdit({ ...outlineEdit, name: event.target.value, error: "" })} placeholder={outlineEdit.label === "体系" ? "例如：校内同步、竞赛提高、A Level" : outlineEdit.label === "专题分类" ? "例如：函数、几何、代数" : outlineEdit.label === "大纲目录" ? "例如：反比例函数、二次函数、动点问题" : outlineEdit.label === "专题" ? "例如：二次函数的性质、二次函数的图像" : "填写你自己的目录名称"} /></label>
      {outlineEdit.error && <p role="alert" className="handout-warning">{outlineEdit.error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setOutlineEdit(null)}>取消</button><button className="primary-button" disabled={busy || !outlineEdit.name.trim()}>{busy ? "正在保存…" : "保存"}</button></div>
    </form></div>}
    {confirmNode}
    {lessonDraft && <div className="modal-backdrop"><form className="modal handout-move" role="dialog" aria-modal="true" aria-label="新建一讲" onSubmit={(event) => { event.preventDefault(); void create(lessonDraft.group, undefined, { ...lessonDraft, open: false }); }}>
      <div className="modal-head"><div><h2>添加讲次</h2><p className="handout-move-hint">{labelGroup(lessonDraft.group)}</p></div><button type="button" className="close" aria-label="关闭" disabled={busy} onClick={() => setLessonDraft(null)}>×</button></div>
      <label className="handout-course-field">讲次<input required type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={lessonDraft.number} onChange={(event) => setLessonDraft({ ...lessonDraft, number: event.target.value, error: "" })} placeholder="例如：8（第8讲）" /></label>
      <label className="handout-course-field">本讲标题<input required maxLength={120} value={lessonDraft.title} onChange={(event) => setLessonDraft({ ...lessonDraft, title: event.target.value, error: "" })} placeholder="例如：一元一次方程" /></label>
      <label className="handout-course-field">模块大纲（选填，每行一个）<textarea rows={6} maxLength={20000} value={lessonDraft.modules} onChange={(event) => setLessonDraft({ ...lessonDraft, modules: event.target.value, error: "" })} placeholder={"方程的概念\n等式的基本性质\n一元一次方程的解法"} /></label>
      {lessonDraft.error && <p role="alert" className="handout-warning">{lessonDraft.error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setLessonDraft(null)}>取消</button><button className="secondary" disabled={busy || !lessonDraft.title.trim()}>保存大纲</button><button type="button" className="primary-button" disabled={busy || !lessonDraft.title.trim()} onClick={() => create(lessonDraft.group, undefined, { ...lessonDraft, open: true })}>保存并编写讲义</button></div>
    </form></div>}

  </main>;
}

function HandoutEditor({ id, user, onNotice }: { id: string; user: AuthUser; onNotice: (message: string, tone?: "success" | "error") => void }) {
  const [confirmNode, confirm] = useConfirm();
  const [doc, setDoc] = useState<Pick<Handout, "title" | "items" | "temporaryQuestions"> | null>(null);
  const [home, setHome] = useState<HandoutGroup & { studentName: string | null; domainName: string | null; coursePath: HandoutCourseNode[] }>({ ...NOWHERE, studentName: null, domainName: null, coursePath: [] });
  const [missing, setMissing] = useState(false);
  const [library, setLibrary] = useState<LibraryData | null>(null);
  const refreshLibrary = useCallback(() => fetchLibrary().then(setLibrary), []);
  const [bankSource, setBankSource] = useState<"library" | "temporary">("library");
  const [treeOpen, setTreeOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  // A link from the course knowledge graph (?module=) opens the handout at that module, ready to add questions to it.
  const [focusModule] = useState(() => new URLSearchParams(window.location.search).get("module"));
  const [picker, setPicker] = useState<PickerMode | null>(() => focusModule ? { kind: "add", sectionId: focusModule, band: "example" } : null);
  // 讲义、小测、作业 share one page; the address keeps the open one, so a reload or a link lands on it.
  const [sheet, setSheet] = useState<HandoutSheet>(() => HANDOUT_SHEETS.find((item) => item.value === new URLSearchParams(window.location.search).get("sheet"))?.value ?? "handout");
  const opened = Boolean(doc);
  const workspace = useQuestionWorkspace("mathpilot-handout-panels", treeOpen, opened);
  const { setPanels, bankPane } = workspace;
  const [outlineTarget, setOutlineTarget] = useState("");
  const [entry, setEntry] = useState<EntryState | null>(null);
  const [typeset, setTypeset] = useState<BasketTypeset | null>(null);
  const [openingTypeset, setOpeningTypeset] = useState(false);
  const typesetSettings = useRef<Partial<Record<HandoutSheet, { order: string; settings: TypesetSettings }>>>({});
  const latest = useRef<Pick<Handout, "title" | "items" | "temporaryQuestions"> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const pending = useRef(false);
  const [noteImports, setNoteImports] = useState<{ sectionId: string; file: File; running: boolean }[]>([]);
  const noteQueue = useRef(noteImports);
  const [dropNote, setDropNote] = useState<string | null>(null);
  // A question dragged by its handle lands beside another question or at the end of a 讲义 lane.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<Parameters<typeof dropHandoutItem>[2] | null>(null);
  const noteFile = useRef<HTMLInputElement>(null);
  const noteTarget = useRef<string | null>(null);

  useEffect(() => () => { noteQueue.current = []; }, []);

  useEffect(() => {
    void fetchHandout(id).then(({ handout }) => { setHome({ courseUnitId: handout.courseUnitId, coursePath: handout.coursePath, domain: handout.domain, domainName: handout.domainName, studentId: handout.studentId, studentName: handout.studentName }); latest.current = { title: handout.title, items: ensureLeadingModule(handout.items, newId()), temporaryQuestions: handout.temporaryQuestions }; setDoc(latest.current); }).catch(() => setMissing(true));
    void refreshLibrary().catch(() => setLibrary({ scope: "public", modules: [], categories: [], questions: [] }));
  }, [id, refreshLibrary]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("id", id);
    if (sheet !== "handout") params.set("sheet", sheet); else params.delete("sheet");
    window.history.replaceState(window.history.state, "", `/tools/handouts?${params}`);
    const pop = () => {
      const next = HANDOUT_SHEETS.find(item => item.value === new URLSearchParams(window.location.search).get("sheet"))?.value ?? "handout";
      if (next !== sheet) { setSheet(next); setPicker(null); setOutlineTarget(""); }
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [id, sheet]);

  useEffect(() => { document.title = `${doc?.title || "讲义"} · 讲义编撰 · MathPilot`; }, [doc?.title]);

  useEffect(() => {
    if (opened && focusModule) document.getElementById(`module-${focusModule}`)?.scrollIntoView({ block: "start" });
  }, [opened, focusModule]);

  // Unsaved text and screenshots still being recognized would be lost on leaving.
  useEffect(() => {
    if (saveState === "saved" && !noteImports.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState, noteImports.length]);

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
    setSheet(next); setPicker(null); setOutlineTarget("");
  }

  function choosePicker(mode: PickerMode) {
    setPanels((current) => ({ ...current, bank: true }));
    setPicker(mode);
    bankPane.current?.scrollIntoView({ block: "nearest" });
  }

  function locateOutline(targetId: string) {
    const target = document.getElementById(targetId);
    if (!target) return;
    setOutlineTarget(targetId);
    target.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    target.focus({ preventScroll: true });
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
    if (!targetModule) { onNotice("请先到题库创建一个模块，再导入题目", "error"); return; }
    const draft = newQuestionDraft(targetModule, targetModule.id);
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

  function entrySaved(current: EntryState, saved: Question[]) {
    // Temporary edits only change this handout's snapshot; imports already have permanent IDs.
    if (current.temporary && current.draft.id) return;
    setLibrary((value) => value && { ...value, questions: [...saved, ...value.questions.filter((item) => !saved.some((entryQuestion) => entryQuestion.id === item.id))] });
    if (current.temporary) return;
    // Editing an existing question only refreshes it; anything newly created joins the handout.
    const created = saved.filter((question) => question.id !== current.draft.id);
    if (!created.length) return;
    writeStored(ENTRY_CATEGORY_KEY, created[0].categoryId);
    if (current.sheet === "handout") insertQuestions(created.map((question) => question.id), current.sectionId, current.band);
    else appendToList(created.map((question) => question.id), current.sheet, current.sectionId);
  }

  // 知识点截图 → AI 转录成小标题、段落、要点和配图，追加到这个模块的知识点里。
  function importNoteScreenshot(sectionId: string, file: File) {
    noteQueue.current = [...noteQueue.current, { sectionId, file, running: false }];
    setNoteImports(noteQueue.current);
    void recognizeNextNote();
  }

  // Two modules can run together; each module keeps its own screenshots in paste order.
  async function recognizeNextNote() {
    const running = noteQueue.current.filter((task) => task.running);
    if (running.length >= 2) return;
    const next = noteQueue.current.find((task) => !task.running && !running.some((active) => active.sectionId === task.sectionId));
    if (!next) return;
    const task = { ...next, running: true };
    const { sectionId, file } = task;
    noteQueue.current = noteQueue.current.map((item) => item === next ? task : item);
    setNoteImports(noteQueue.current);
    void recognizeNextNote();
    try {
      if (!latest.current?.items.some((item) => item.kind === "section" && item.id === sectionId)) return;
      const image = await readScreenshot(file);
      if (!noteQueue.current.includes(task)) return;
      const result = await recognizeScreenshot<NoteRecognitionResult>("/api/recognize-note", image);
      if (!noteQueue.current.includes(task) || !latest.current?.items.some((item) => item.kind === "section" && item.id === sectionId)) return;
      // Every figure is cut from one analysis of the screenshot: its own strokes only, on clean white.
      const { extractNoteFigures } = await import("../../../lib/note-figures");
      const cuts = await extractNoteFigures(image, result.blocks);
      const figures = new Map<RecognizedNoteFigure, string>(); let missedFigures = 0;
      for (const block of result.blocks) {
        const blockFigures = block.type === "figures" ? block.figures : block.type === "table" ? block.rows.flatMap((row) => row.flatMap((cell) => cell.figures)) : [];
        for (const figure of blockFigures) {
          const cut = cuts.get(figure);
          try { if (!cut) throw new Error("没有裁出配图"); figures.set(figure, (await uploadHandoutImage(cut)).url); } catch { missedFigures += 1; }
        }
      }
      const text = noteFromBlocks(result.blocks, (figure) => figures.get(figure) ?? null);
      if (!text.trim()) throw new Error("截图里没有识别到知识点文字");
      if (!noteQueue.current.includes(task) || !latest.current?.items.some((item) => item.kind === "section" && item.id === sectionId)) return;
      setItems(latest.current!.items.map((item) => item.id === sectionId && item.kind === "section" ? { ...item, note: item.note.trim() ? `${item.note.trimEnd()}\n${text}` : text } : item));
      const checks = [...(missedFigures ? [`${missedFigures} 张配图未能裁剪`] : []), ...result.warnings.slice(0, 2)];
      onNotice(checks.length ? `已识别，请核对：${checks.join("；")}` : "已识别并加入知识点");
    } catch (error) { if (noteQueue.current.includes(task)) onNotice(`${file.name}：${error instanceof Error ? error.message : "识别失败，请重试"}`, "error"); }
    finally {
      if (noteQueue.current.includes(task)) {
        noteQueue.current = noteQueue.current.filter((item) => item !== task);
        setNoteImports(noteQueue.current);
        void recognizeNextNote();
      }
    }
  }

  function chooseNoteScreenshot(sectionId: string) {
    noteTarget.current = sectionId;
    document.getElementById(`knowledge-${sectionId}`)?.focus({ preventScroll: true });
    noteFile.current?.click();
  }

  async function openTypeset() {
    if (!doc || openingTypeset) return;
    setOpeningTypeset(true);
    try {
      if (saveState !== "saved") await flush();
      const current = latest.current!;
      const find = (_scope: unknown, questionId: string) => resolve(questionId);
      const handout = sheet === "handout" ? handoutSections(current.items, find) : null;
      const list = sheet === "handout" ? null : sheetQuestions(current.items, sheet, find);
      const questions = handout ? handout.modules.flatMap((module) => HANDOUT_BANDS.flatMap((band) => module.bands[band])) : list!.questions;
      if (!questions.length) throw new Error("当前资料没有可读取的题目，请先加入题目。");
      const temporaryIds = new Set(current.temporaryQuestions.map((question) => question.id));
      const ids = [...new Set(questions.filter((question) => !temporaryIds.has(question.id)).map((question) => question.id))];
      if (ids.length) await authorizeDownload(ids);
      const order = JSON.stringify(handout
        ? handout.modules.flatMap((module) => HANDOUT_BANDS.flatMap((band) => module.bands[band].map((question) => [question.id, band])))
        : questions.map((question) => question.id));
      const previous = typesetSettings.current[sheet];
      setTypeset({
        title: current.title, questions,
        handout: handout ?? { sheet: sheetLabel(sheet), missingCount: list!.missingCount },
        settings: previous ? { ...previous.settings, ownRoom: previous.order === order ? previous.settings.ownRoom : {} } : { answers: "end", showSource: true },
        studentId: home.studentId ?? undefined,
        origin: { back: "← 讲义编辑", name: sheetLabel(sheet), hint: "点击返回继续编辑" },
        onClose: (title, settings) => {
          typesetSettings.current[sheet] = { order, settings };
          if (title && title !== latest.current!.title) edit({ title });
          setTypeset(null);
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".handout-bar .primary-button")?.focus());
        },
      });
    } catch (error) { onNotice(error instanceof Error ? error.message : "打开快速排版失败", "error"); }
    finally { setOpeningTypeset(false); }
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
  const saveLabel = { saved: "已保存", editing: "编辑中", saving: "保存中…", failed: "保存失败" }[saveState];
  // The back link names where this handout lives and returns to that shelf.
  const homeShelf = shelfOf(home);
  const backLabel = groupLabel(home);
  const backHref = homeShelf === "student" ? `/tools/handouts?shelf=student&student=${encodeURIComponent(home.studentId ?? "")}` : homeShelf === "course" ? `/tools/handouts?shelf=course&course=${encodeURIComponent(home.coursePath[0]?.id ?? "")}&stage=${encodeURIComponent(home.coursePath[1]?.id ?? "")}` : `/tools/handouts?shelf=topic&topic=${encodeURIComponent(home.coursePath[2]?.id ?? home.coursePath[1]?.id ?? home.domain ?? "unsorted")}`;

  const draggedItem = doc.items.find(item => item.id === dragging);
  const drop = (event: DragEvent, target = dropAt) => {
    if (!dragging || !target) return;
    event.preventDefault(); event.stopPropagation();
    const next = dropHandoutItem(doc.items, dragging, target);
    if (next !== doc.items) { setItems(next); setOutlineTarget(`question-${dragging}`); }
    setDragging(null); setDropAt(null);
  };
  const dropMark = (item: HandoutItem) => dropAt && "itemId" in dropAt && dropAt.itemId === item.id && dragging !== item.id ? dropAt.after ? " drop-after" : " drop-before" : "";
  const cardDrop = (item: HandoutItem, horizontal = false) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => { if (!draggedItem || draggedItem.kind !== item.kind) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; const box = event.currentTarget.getBoundingClientRect(); const after = horizontal ? event.clientX > box.left + box.width / 2 : event.clientY > box.top + box.height / 2; if (!(dropAt && "itemId" in dropAt && dropAt.itemId === item.id && dropAt.after === after)) setDropAt({ itemId: item.id, after }); },
    onDrop: (event: DragEvent<HTMLElement>) => { const box = event.currentTarget.getBoundingClientRect(); drop(event, { itemId: item.id, after: horizontal ? event.clientX > box.left + box.width / 2 : event.clientY > box.top + box.height / 2 }); },
  });
  const laneDrop = (sectionId: string, band: HandoutBand) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => { if (draggedItem?.kind !== "question") return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; if (!(dropAt && !("itemId" in dropAt) && dropAt.sectionId === sectionId && dropAt.band === band)) setDropAt({ sectionId, band }); },
    onDrop: (event: DragEvent<HTMLElement>) => drop(event, { sectionId, band }),
  });
  // The body grip and outline number share one drag path; ↑ ↓ reorder within their current lane.
  const dragHandle = (item: HandoutItem, name: string, outlineNumber?: string) => <button key={item.id} type="button" className={outlineNumber === undefined ? "handout-drag" : `handout-outline-number${dropMark(item)}${dragging === item.id ? " is-dragging" : ""}`} draggable
    aria-label={outlineNumber === undefined ? `拖动${name}调整顺序` : `定位${name}`} aria-current={outlineNumber !== undefined && outlineTarget === `question-${item.id}` ? "location" : undefined}
    title={outlineNumber === undefined ? "拖动调整顺序，也可按 ↑ ↓ 键" : "点击定位；拖动到其他模块或题号前后；↑ ↓ 调整本栏顺序"}
    onDragStart={(event) => { setDragging(item.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", name); const card = event.currentTarget.closest("article"); if (card) event.dataTransfer.setDragImage(card, 16, 16); }}
    onClick={(event) => { if (outlineNumber !== undefined) locateOutline(`question-${item.id}`); else if (event.detail) event.currentTarget.blur(); }}
    onDragEnd={(event) => { event.currentTarget.blur(); setDragging(null); setDropAt(null); }}
    onKeyDown={(event) => { const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0; if (direction) { event.preventDefault(); setItems(moveHandoutItem(doc.items, item.id, direction)); } }}
    {...(outlineNumber === undefined ? {} : cardDrop(item, true))}>{outlineNumber ?? <GripIcon />}</button>;
  // One question as the handout prints it, with one quiet line underneath: where it comes from, its 考点 and the actions.
  // 移出讲义 stays a visible red button; the rest of the actions are plain text buttons.
  const questionCard = (item: QuestionItem, band: HandoutBand) => {
    const question = resolve(item.questionId);
    const temporary = doc.temporaryQuestions.some((entry) => entry.id === item.questionId);
    const label = numbers.get(item.id) ?? ""; const name = band === "practice" ? `练习 ${label}` : label;
    const points = question ? questionPoints(question) : [];
    return <article className={`handout-question${dropMark(item)}`} key={item.id} id={`question-${item.id}`} tabIndex={-1} {...cardDrop(item)}>
      {dragHandle(item, name)}
      {question ? <QuestionBody question={question} number={label} /> : <p className="handout-missing">{libraryReady ? "原题已删除或无权访问，可替换或移出。" : "正在读取题目…"}</p>}
      <div className="handout-question-foot">
        {question && library && <small>{question.type} · {temporary ? "临时题库" : categoryPath(library.modules, library.categories, question.categoryId)}</small>}
        {question && <span className="handout-points">{points.length
          ? points.map((point) => <b key={point}>{point}</b>)
          : question.canEdit ? <button className="text-button" onClick={() => openEditEntry(question)}>未标知识点 · 补充</button> : <em>未标知识点</em>}</span>}
        <div className="handout-actions">
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
  const listCard = (item: ListItem, index: number) => {
    const question = resolve(item.questionId);
    const temporary = doc.temporaryQuestions.some((entry) => entry.id === item.questionId);
    const label = String(index + 1); const list = sheetLabel(item.kind); const name = `${list} ${label}`;
    return <SheetQuestion className={dropMark(item)} key={item.id} id={`question-${item.id}`} {...cardDrop(item)} question={question} loading={!libraryReady} number={label} grip={dragHandle(item, name)}
      metadata={question && library && <small>{question.type} · {temporary ? "临时题库" : categoryPath(library.modules, library.categories, question.categoryId)}</small>}>
        <label className="handout-tests">考查
          <select aria-label={`${name} 考查模块`} value={item.moduleId ?? ""} onChange={(event) => setItems(doc.items.map((entry) => entry.id === item.id ? { ...item, moduleId: event.target.value || null } : entry))}>
            {!item.moduleId && <option value="">未选模块</option>}
            {moduleOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <div className="handout-actions">
          <button disabled={!libraryReady} onClick={() => choosePicker({ kind: "replace", itemId: item.id, label: `替换 ${name}` })}>替换</button>
          {question?.canEdit && <PaperMoreMenu label="题目更多操作"><button onClick={() => openEditEntry(question)}>{temporary ? "编辑临时题" : "编辑原题"}</button></PaperMoreMenu>}
          <button className="danger" aria-label={`${name} 移出${list}`} onClick={() => setItems(doc.items.filter((entry) => entry.id !== item.id))}>移出{list}</button>
        </div>
    </SheetQuestion>;
  };
  // The bank keeps adding to the module it last pointed at.
  const addTarget = activePicker.kind === "add" ? activePicker.sectionId : modules[0]?.section.id ?? null;

  return <><main className="toolbox handouts handout-editor" inert={Boolean(typeset)}>
    {confirmNode}
    <header className="handout-bar">
      <a className="handout-brand" href={backHref} aria-label="返回讲义书架" title="返回讲义书架"><BrandWordmark /></a>
      <span className="handout-location"><span>讲义编撰</span><span aria-hidden="true">/</span><span title={backLabel}>{backLabel}</span></span>
      <span className={`handout-save ${saveState}`} role="status">{saveLabel}{saveState === "failed" && <button className="text-button" onClick={() => void flush().catch(() => {})}>重试</button>}</span>
      <button className="primary-button" disabled={!questionCount || !libraryReady || openingTypeset} onClick={() => void openTypeset()}>{openingTypeset ? "正在打开…" : "快速排版"}</button>
    </header>
    <QuestionWorkspace {...workspace} outlineLabel={sheetLabel(sheet)} draftLabel="讲义编辑" bank={
        <QuestionPicker library={library} user={user} onLibraryChanged={refreshLibrary} treeOpen={treeOpen} onTreeOpenChange={setTreeOpen} mode={activePicker} sheet={sheet} taken={taken} usedIn={usedIn} onPick={(ids) => pick(ids, activePicker)} onModeChange={setPicker}
          source={bankSource} onSourceChange={setBankSource} temporaryQuestions={doc.temporaryQuestions} onImport={openTemporaryImport} onNotice={onNotice}
          sections={moduleOptions} />
    } outline={<>
          <header><h2>{sheetLabel(sheet)}结构</h2><span>{questionCount} 题</span></header>
          <div className="handout-outline-scroll" onDragOver={() => { if (dragging) setDropAt(null); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null); }}>
            <button type="button" className="handout-outline-title" aria-current={outlineTarget === "handout-heading" ? "location" : undefined} onClick={() => locateOutline("handout-heading")}>{doc.title || "未命名讲义"}</button>
            {sheet === "handout" ? modules.map(({ section, bands }, index) => {
              const heading = moduleHeading(section.title, index);
              const landing = dropAt && !("itemId" in dropAt) && dropAt.sectionId === section.id;
              return <section className={`handout-outline-module${landing ? " dropping" : ""}`} key={section.id} {...laneDrop(section.id, draggedItem?.kind === "question" ? draggedItem.band ?? "example" : "example")}>
                <button type="button" className="handout-outline-heading" aria-label={`定位模块${heading.numeral}`} aria-current={outlineTarget === `module-${section.id}` ? "location" : undefined} onClick={() => locateOutline(`module-${section.id}`)}>模块{heading.numeral}</button>
                <button type="button" className="handout-outline-note" aria-label={`定位模块${heading.numeral}知识点`} aria-current={outlineTarget === `knowledge-${section.id}` ? "location" : undefined} onClick={() => locateOutline(`knowledge-${section.id}`)}>知识点</button>
                {HANDOUT_BANDS.filter(band => bands[band].length).map(band => <div className={`handout-outline-band${landing && dropAt.band === band ? " dropping" : ""}`} key={band} {...laneDrop(section.id, band)}>
                  <span>{HANDOUT_PARTS[band].label}</span>
                  <div className="basket-outline-questions">{bands[band].map(item => dragHandle(item, `模块${heading.numeral}${HANDOUT_PARTS[band].label} ${numbers.get(item.id)}`, numbers.get(item.id)))}</div>
                </div>)}
              </section>;
            }) : <div className="basket-outline-questions">{listed.map((item, index) => dragHandle(item, `${sheetLabel(sheet)}第 ${index + 1} 题`, String(index + 1)))}</div>}
            {!questionCount && <p className="handout-muted">尚未加入题目</p>}
          </div>
    </>}>
    <div className="handout-draft-head" id="handout-heading" tabIndex={-1}>
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
        {listed.map((item, index) => listCard(item, index))}
      </div>
    </section> : <>
    {modules.map(({ section, bands }, moduleIndex) => {
      const heading = moduleHeading(section.title, moduleIndex); const badge = `模块${heading.numeral}`;
      const noteRunning = noteImports.some((task) => task.sectionId === section.id && task.running);
      const noteWaiting = noteImports.filter((task) => task.sectionId === section.id && !task.running).length;
      return <section className="handout-module" key={section.id} id={`module-${section.id}`} tabIndex={-1} aria-label={badge}>
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

        <div className={`handout-lane knowledge${dropNote === section.id ? " dropping" : ""}`} id={`knowledge-${section.id}`} tabIndex={-1}
          onPaste={(event) => { const file = clipboardImage(event); if (file) { event.preventDefault(); void importNoteScreenshot(section.id, file); } }}
          onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDropNote(section.id); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropNote(null); }}
          onDrop={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDropNote(null); const file = droppedImage(event); if (file) void importNoteScreenshot(section.id, file); else onNotice("请选择图片文件"); }}>
          <div className="handout-lane-head"><b>{HANDOUT_PARTS.knowledge.label}</b>
            <div className="handout-lane-add">
              {(noteRunning || noteWaiting > 0) && <em role="status">{noteRunning ? "正在识别…" : ""}{noteWaiting > 0 ? `${noteRunning ? " · " : ""}排队 ${noteWaiting} 张` : ""}</em>}
              {dropNote === section.id ? <em>松开即可识别截图</em> : <button className="text-button" title="选择、拖入或粘贴知识点截图，可连续提交" onMouseDown={(event) => event.preventDefault()} onClick={() => chooseNoteScreenshot(section.id)}>截图识别</button>}
            </div>
          </div>
          <Suspense fallback={<div className="note-editor"><div className="note-editor-body"><NotePreview note={section.note} /></div></div>}>
            <NoteEditor value={section.note} label={`${badge}知识点`} placeholder={HANDOUT_PARTS.knowledge.hint} onChange={(note) => updateSection(section.id, { note })} onCommit={() => void flush().catch(() => {})} />
          </Suspense>
        </div>

        {HANDOUT_BANDS.map((band) => {
          const lane = bands[band];
          // The lane the bank is adding to is marked, so it is always clear where picked questions go.
          const target = activePicker.kind === "add" && activePicker.sectionId === section.id && activePicker.band === band;
          const landing = dropAt && !("itemId" in dropAt) && dropAt.sectionId === section.id && dropAt.band === band;
          return <div className={`handout-lane ${band}${target ? " target" : ""}${landing ? " dropping" : ""}`} key={band} {...laneDrop(section.id, band)}>
            <div className="handout-lane-head"><b>{HANDOUT_PARTS[band].label}</b><span className={`handout-count${lane.length ? "" : " zero"}`} aria-label={`${lane.length} 道题`}>{lane.length}</span>
              <div className="handout-lane-add">
                <button className="text-button" aria-pressed={target} disabled={!libraryReady} onClick={() => choosePicker({ kind: "add", sectionId: section.id, band })}>从题库选题</button>
                <button className="text-button" disabled={!libraryReady} onClick={() => openNewEntry(section.id, band)}>录入新题</button>
              </div>
            </div>
            {lane.map((item) => questionCard(item, band))}
          </div>;
        })}
      </section>;
    })}
    <button className="handout-add-section" onClick={addModule}>＋ 添加知识模块</button>
    </>}

    </QuestionWorkspace>

    <input ref={noteFile} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file && noteTarget.current) void importNoteScreenshot(noteTarget.current, file); event.target.value = ""; }} />
    {entry && library && <QuestionEntry initial={entry.draft} modules={library.modules} categories={library.categories}
      moduleIds={entry.draft.id && !entry.temporary ? [entry.draft.moduleId ?? ""] : library.modules.map((item) => item.id)}
      saveTemporaryQuestions={entry.temporary ? saveTemporaryQuestions : undefined} startWithFile={entry.temporary && !entry.draft.id}
      onSaved={(saved) => entrySaved(entry, saved)} onClose={() => setEntry(null)} onNotice={onNotice} />}
  </main>{typeset && <div className="handout-typeset" role="dialog" aria-modal="true" aria-label="快速排版">
    <Suspense fallback={<p role="status">正在打开快速排版…</p>}><Typesetter basket={typeset} /></Suspense>
  </div>}</>;
}
