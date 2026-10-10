"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- client-only vinext navigation */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { arrangeHandouts, authorizeDownload, createHandout, deleteHandout, fetchHandout, fetchHandouts, fetchLibrary, fetchMe, updateHandout, uploadHandoutImage } from "../../../lib/api-client";
import { DEFAULT_HANDOUT_TITLE, HANDOUT_BANDS, HANDOUT_GRADES, HANDOUT_PARTS, HANDOUT_TERMS, ensureLeadingModule, handoutModules, handoutNumbers, handoutSections, insertIndexForSection, moduleHeading, moveHandoutItem, placementLabel, questionPoints, setItemBand } from "../../../lib/handout-rules.mjs";
import { categoryPath } from "../../../lib/library-tree";
import type { WordAnswerPlacement } from "../../../lib/export-word";
import type { LatexStatus } from "../../../lib/handout-latex-files";
import { noteFromBlocks, type RecognizedNoteFigure } from "../../../lib/handout-note.mjs";
import { clipboardImage } from "../../../lib/image-tools";
import { randomClientId } from "../../../lib/client-random-id.mjs";
import { droppedImage, readScreenshot, recognizeScreenshot } from "../../../lib/screenshot-recognition";
import type { NoteRecognitionResult } from "../../../lib/recognition-contract";
import type { AuthUser, Handout, HandoutBand, HandoutGrade, HandoutItem, HandoutTerm, HandoutSummary, LibraryData, Question } from "../../../lib/types";
import { PaperMoreMenu } from "../../components/PaperMoreMenu";
import { QuestionBody } from "../../components/QuestionBody";
import { editableQuestionDraft, newQuestionDraft, QuestionEntry } from "../../components/QuestionEntry";
import { QuestionPicker, type PickerMode } from "./QuestionPicker";
import { NotePreview } from "./NotePreview";
import "../tools.css";
import "./handouts.css";
import "../../components/note-editor.css";

type SaveState = "saved" | "editing" | "saving" | "failed";
type EntryState = { draft: Question; sectionId: string | null; band: HandoutBand };
type SectionItem = Extract<HandoutItem, { kind: "section" }>;
type QuestionItem = Extract<HandoutItem, { kind: "question" }>;
type ExportFormat = "pdf" | "word";

const ENTRY_CATEGORY_KEY = "mitty-handout-entry-category";
const ANSWER_CHOICES: { value: WordAnswerPlacement; label: string; hint: string }[] = [
  { value: "none", label: "不附", hint: "学生版：例题留课堂笔记区，练习和变式留作答空间。" },
  { value: "end", label: "文末", hint: "学生版正文，答案与解析按例题、练习、变式分组附在文末。" },
  { value: "each", label: "每题后", hint: "教师版：每道题后紧跟答案与解析。" },
];
// The editor engine loads with the first module; until then the note shows as it reads.
const NoteEditor = lazy(() => import("../../components/NoteEditor"));
// crypto.randomUUID only exists on secure origins; colleagues use the plain-http LAN address.
const newId = () => randomClientId();

function HandoutIcon({ name }: { name: "back" | "book" }) {
  const paths = {
    back: <path d="m10 5-7 7 7 7M3 12h18" />,
    book: <><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5v-13Z" /><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5v-13Z" /><path d="M6.5 8H9M6.5 11H9M15 8h2.5M15 11h2.5" /></>,
  } as const;
  return <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
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
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    void fetchMe().then((result) => { setOpenId(id); setUser(result.user); }).catch(() => setNotice("登录状态读取失败，请刷新重试")).finally(() => setLoaded(true));
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2600); return () => clearTimeout(timer); }, [notice]);

  if (!loaded) return <main className="toolbox handouts"><p>正在读取…</p></main>;
  if (!user) return <main className="toolbox handouts"><h1>讲义编撰</h1><p>请先登录 Mitty 主站。</p><a href="/">返回主站</a></main>;
  return <>
    {openId ? <HandoutEditor id={openId} onNotice={setNotice} /> : <HandoutList canDelete={user.role === "admin"} onNotice={setNotice} />}
    {notice && <div className="toast" role="status">✓ {notice}</div>}
  </>;
}

const GRADE_KEY = "mitty-handout-grade";
type Placement = { grade: HandoutGrade; term: HandoutTerm };
type MoveState = { handout: HandoutSummary; grade: HandoutGrade; term: HandoutTerm };
const sameTerm = (handout: HandoutSummary, placement: Placement) => handout.grade === placement.grade && handout.term === placement.term;
const lessonName = (index: number) => `第${index + 1}讲`;

// 讲义全员共用：任何老师都能新建、编辑、调整课次；删除只开放给管理员。
function HandoutList({ canDelete, onNotice }: { canDelete: boolean; onNotice: (message: string) => void }) {
  const [handouts, setHandouts] = useState<HandoutSummary[] | null>(null);
  const [grade, setGrade] = useState<HandoutGrade>(() => {
    const value = Number(new URLSearchParams(window.location.search).get("grade") || readStored(GRADE_KEY));
    return HANDOUT_GRADES.find((item) => item.value === value)?.value ?? HANDOUT_GRADES[0].value;
  });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<MoveState | null>(null);

  useEffect(() => { void fetchHandouts().then((result) => setHandouts(result.handouts)).catch((error) => { setHandouts([]); onNotice(error instanceof Error ? error.message : "讲义列表读取失败"); }); }, [onNotice]);

  function chooseGrade(value: HandoutGrade) { setGrade(value); writeStored(GRADE_KEY, String(value)); }
  // The server lists by position, so a term's handouts are already in 课次 order.
  const lessons = (placement: Placement) => (handouts ?? []).filter((item) => sameTerm(item, placement));

  // A new 课次 goes to the end of its term; a copy goes to the end of the original's term.
  async function create(placement: Partial<Placement>, source?: HandoutSummary) {
    if (busy) return;
    setBusy(true);
    try {
      const draft = source ? (await fetchHandout(source.id)).handout : null;
      const { handout } = await createHandout(draft
        ? { title: `${draft.title}（副本）`, items: draft.items.map((item) => ({ ...item, id: newId() })), ...placement }
        : { title: DEFAULT_HANDOUT_TITLE, items: [], ...placement });
      window.location.assign(`/tools/handouts?id=${encodeURIComponent(handout.id)}`);
    } catch (error) { onNotice(error instanceof Error ? error.message : "讲义创建失败"); setBusy(false); }
  }

  // Positions follow the order sent; the list updates first and rolls back if the server refuses.
  async function arrange(placement: Placement, ids: string[], message: string) {
    const before = handouts;
    const position = new Map(ids.map((id, index) => [id, index]));
    setHandouts((current) => current && current.map((item) => position.has(item.id) ? { ...item, ...placement, position: position.get(item.id)! } : item)
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt));
    try { await arrangeHandouts(placement, ids); onNotice(message); }
    catch (error) { setHandouts(before); onNotice(error instanceof Error ? error.message : "课次调整失败"); }
  }

  function shift(handout: HandoutSummary, direction: -1 | 1) {
    const placement = { grade: handout.grade!, term: handout.term! };
    const ids = lessons(placement).map((item) => item.id);
    const from = ids.indexOf(handout.id); const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void arrange(placement, ids, `已调到${lessonName(to)}`);
  }

  function move(state: MoveState) {
    const placement = { grade: state.grade, term: state.term };
    setMoving(null);
    if (sameTerm(state.handout, placement)) return;
    const ids = [...lessons(placement).map((item) => item.id), state.handout.id];
    void arrange(placement, ids, `已移到${placementLabel(placement)} · ${lessonName(ids.length - 1)}`);
  }

  async function remove(handout: HandoutSummary, name: string) {
    if (!window.confirm(`删除${name}“${handout.title}”？题目仍保留在题库中。`)) return;
    try { await deleteHandout(handout.id); setHandouts((current) => current?.filter((item) => item.id !== handout.id) ?? null); onNotice("讲义已删除"); }
    catch (error) { onNotice(error instanceof Error ? error.message : "讲义删除失败"); }
  }

  const row = (handout: HandoutSummary, lesson: { index: number; size: number } | null, location?: string) => {
    const name = lesson ? lessonName(lesson.index) : "讲义";
    return <li key={handout.id}>
      {lesson && <span className="handout-lesson">{name}</span>}
      <a href={`/tools/handouts?id=${encodeURIComponent(handout.id)}`}><strong>{handout.title}</strong><span>{location ? `${location} · ` : ""}{handout.questionCount} 题 · 更新于 {new Date(handout.updatedAt).toLocaleDateString("zh-CN")}</span></a>
      {lesson && <div className="handout-actions">
        <button aria-label={`${name}上移`} disabled={lesson.index === 0} onClick={() => shift(handout, -1)}>↑</button>
        <button aria-label={`${name}下移`} disabled={lesson.index === lesson.size - 1} onClick={() => shift(handout, 1)}>↓</button>
      </div>}
      <PaperMoreMenu label="讲义更多操作">
        <button disabled={busy} onClick={() => create(handout.grade && handout.term ? { grade: handout.grade, term: handout.term } : {}, handout)}>复制一份</button>
        <button onClick={() => setMoving({ handout, grade: handout.grade ?? grade, term: handout.term ?? HANDOUT_TERMS[0].value })}>{handout.grade ? "移到其他学期" : "归入课次"}</button>
        {canDelete && <button onClick={() => remove(handout, lesson ? name : "")}>删除</button>}
      </PaperMoreMenu>
    </li>;
  };

  const keyword = query.trim().toLowerCase();
  const unfiled = (handouts ?? []).filter((item) => !item.grade || !item.term);
  const located = (handout: HandoutSummary) => {
    if (!handout.grade || !handout.term) return "未归类";
    const placement = { grade: handout.grade, term: handout.term };
    return `${placementLabel(placement)} · ${lessonName(lessons(placement).indexOf(handout))}`;
  };
  return <main className="toolbox handouts">
    <a className="toolbox-back" href="/tools"><HandoutIcon name="back" /><span>返回工具箱</span></a>
    <header className="toolbox-head handouts-head">
      <span className="toolbox-mark"><HandoutIcon name="book" /></span>
      <div><h1>讲义编撰</h1><p>按年级、学期编排每一讲的讲义；从题库选题或录入外部题目。</p></div>
    </header>
    {handouts === null ? <p className="handout-muted">正在读取讲义…</p> : <>
      {handouts.length > 6 && <input className="handout-search" type="search" aria-label="按标题查找讲义" placeholder="在全部年级中按标题查找" value={query} onChange={(event) => setQuery(event.target.value)} />}
      {keyword ? <>
        <ul className="handout-list">{handouts.filter((item) => item.title.toLowerCase().includes(keyword)).map((item) => row(item, null, located(item)))}</ul>
        {!handouts.some((item) => item.title.toLowerCase().includes(keyword)) && <p className="handout-muted">没有标题包含“{query.trim()}”的讲义。</p>}
      </> : <>
        {!!unfiled.length && <section className="handout-term unfiled" aria-label="未归类">
          <div className="handout-term-head"><h2>未归类</h2><span>用「更多 → 归入课次」放到对应年级和学期</span></div>
          <ul className="handout-list">{unfiled.map((item) => row(item, null))}</ul>
        </section>}
        <div className="handout-grades" role="tablist" aria-label="年级">
          {HANDOUT_GRADES.map((item) => {
            const count = handouts.filter((handout) => handout.grade === item.value && handout.term).length;
            return <button key={item.value} role="tab" aria-selected={grade === item.value} className={grade === item.value ? "active" : ""} onClick={() => chooseGrade(item.value)}>{item.label}{count ? <small>{count} 讲</small> : null}</button>;
          })}
        </div>
        {HANDOUT_TERMS.map((term) => {
          const placement = { grade, term: term.value }; const list = lessons(placement);
          return <section className="handout-term" key={term.value} aria-label={placementLabel(placement)}>
            <div className="handout-term-head"><h2>{term.label}</h2><span>{list.length ? `${list.length} 讲` : "还没有课次"}</span></div>
            {!!list.length && <ul className="handout-list">{list.map((item, index) => row(item, { index, size: list.length }))}</ul>}
            <button className="handout-add-lesson" disabled={busy} onClick={() => create(placement)}>＋ 添加{lessonName(list.length)}</button>
          </section>;
        })}
      </>}
    </>}
    {moving && <div className="modal-backdrop"><section className="modal handout-move" role="dialog" aria-modal="true" aria-label="移到课次">
      <div className="modal-head"><div><span className="eyebrow">{moving.handout.grade ? "移到其他学期" : "归入课次"}</span><h2>{moving.handout.title}</h2></div><button className="close" aria-label="关闭" onClick={() => setMoving(null)}>×</button></div>
      <fieldset className="handout-answer-choice"><legend>年级</legend>
        <div>{HANDOUT_GRADES.map((item) => <label key={item.value} className={moving.grade === item.value ? "active" : ""}><input type="radio" name="handout-move-grade" checked={moving.grade === item.value} onChange={() => setMoving({ ...moving, grade: item.value })} />{item.label}</label>)}</div>
      </fieldset>
      <fieldset className="handout-answer-choice"><legend>学期</legend>
        <div className="four">{HANDOUT_TERMS.map((item) => <label key={item.value} className={moving.term === item.value ? "active" : ""}><input type="radio" name="handout-move-term" checked={moving.term === item.value} onChange={() => setMoving({ ...moving, term: item.value })} />{item.label}</label>)}</div>
        <p>{sameTerm(moving.handout, moving) ? "已在这个学期。" : `将成为${placementLabel(moving)}的${lessonName(lessons(moving).length)}。`}</p>
      </fieldset>
      <div className="modal-actions"><button className="secondary" onClick={() => setMoving(null)}>取消</button><button className="primary-button" disabled={sameTerm(moving.handout, moving)} onClick={() => move(moving)}>确定</button></div>
    </section></div>}
  </main>;
}

function HandoutEditor({ id, onNotice }: { id: string; onNotice: (message: string) => void }) {
  const [doc, setDoc] = useState<Pick<Handout, "title" | "items"> | null>(null);
  const [home, setHome] = useState<Pick<Handout, "grade" | "term">>({ grade: null, term: null });
  const [missing, setMissing] = useState(false);
  const [library, setLibrary] = useState<LibraryData | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [picker, setPicker] = useState<PickerMode | null>(null);
  const bankPane = useRef<HTMLDivElement>(null);
  const [entry, setEntry] = useState<EntryState | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [answers, setAnswers] = useState<WordAnswerPlacement>("end");
  const [exporting, setExporting] = useState<ExportFormat | "source" | null>(null);
  const [latexStatus, setLatexStatus] = useState<LatexStatus | null>(null);
  const latest = useRef<Pick<Handout, "title" | "items"> | null>(null);
  const saving = useRef(false);
  const pending = useRef(false);
  const [noteImport, setNoteImport] = useState<string | null>(null);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const noteFile = useRef<HTMLInputElement>(null);
  const noteTarget = useRef<string | null>(null);


  useEffect(() => {
    void fetchHandout(id).then(({ handout }) => { setHome({ grade: handout.grade, term: handout.term }); latest.current = { title: handout.title, items: ensureLeadingModule(handout.items, newId()) }; setDoc(latest.current); }).catch(() => setMissing(true));
    void fetchLibrary().then(setLibrary).catch(() => setLibrary({ scope: "public", modules: [], categories: [], questions: [] }));
  }, [id]);

  // Unsaved text or a failed save would be lost on leaving.
  useEffect(() => {
    if (saveState === "saved") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  // Items saved before the two libraries merged may still say scope "mine"; the id alone finds the question.
  const questionIndex = useMemo(() => new Map((library?.questions ?? []).map((question) => [question.id, question])), [library]);
  const resolve = (questionId: string) => questionIndex.get(questionId);
  const libraryReady = Boolean(library);

  // One request at a time; whatever is newest when it finishes is sent next.
  async function flush() {
    if (saving.current) { pending.current = true; return; }
    saving.current = true; setSaveState("saving");
    try {
      do { pending.current = false; await updateHandout({ id, ...latest.current! }); } while (pending.current);
      setSaveState("saved");
    } catch { setSaveState("failed"); }
    finally { saving.current = false; }
  }
  function edit(next: Partial<Pick<Handout, "title" | "items">>, save = true) {
    latest.current = { ...latest.current!, ...next }; setDoc(latest.current);
    if (save) void flush(); else setSaveState("editing");
  }
  const setItems = (items: HandoutItem[], save = true) => edit({ items }, save);
  const updateSection = (itemId: string, changes: { title?: string; note?: string }) => setItems(latest.current!.items.map((item) => item.id === itemId && item.kind === "section" ? { ...item, ...changes } : item), false);

  function insertQuestions(questionIds: string[], sectionId: string | null, band: HandoutBand) {
    const items = latest.current!.items;
    const at = insertIndexForSection(items, sectionId);
    const added = questionIds.map((questionId): HandoutItem => ({ id: newId(), kind: "question", scope: "public", questionId, band }));
    setItems([...items.slice(0, at), ...added, ...items.slice(at)]);
  }

  // A replacement keeps the slot: same module, same band, same position.
  function pick(questionIds: string[], target: PickerMode) {
    if (target.kind === "replace") {
      const [questionId] = questionIds; const itemId = target.itemId;
      setItems(latest.current!.items.map((item) => item.id === itemId && item.kind === "question" ? { ...item, scope: "public", questionId } : item));
      onNotice("题目已替换");
    } else { insertQuestions(questionIds, target.sectionId, target.band); onNotice(`已加入 ${questionIds.length} 道${HANDOUT_PARTS[target.band].label}`); }
    if (target.kind === "replace") setPicker(null);
  }

  function choosePicker(mode: PickerMode) {
    setPicker(mode);
    bankPane.current?.scrollIntoView({ block: "nearest" });
  }

  function changeBand(itemId: string, band: HandoutBand) {
    setItems(setItemBand(latest.current!.items, itemId, band));
    onNotice(`已改为${HANDOUT_PARTS[band].label}`);
  }

  function removeModule(section: SectionItem, questions: QuestionItem[], name: string) {
    if (questions.length && !window.confirm(`删除“${name}”及其中 ${questions.length} 道题？题目仍保留在题库中。`)) return;
    const removed = new Set([section.id, ...questions.map((item) => item.id)]);
    setItems(latest.current!.items.filter((item) => !removed.has(item.id)));
  }

  function openNewEntry(sectionId: string | null, band: HandoutBand) {
    if (!library) return;
    if (!library.modules.length) { onNotice("题库还没有模块，请先到题库创建一个模块"); return; }
    const remembered = readStored(ENTRY_CATEGORY_KEY);
    const category = library.categories.find((item) => item.id === remembered);
    const targetModule = library.modules.find((item) => item.id === (category?.moduleId ?? remembered)) ?? library.modules[0];
    setEntry({ draft: newQuestionDraft(targetModule, category && category.moduleId === targetModule.id ? category.id : targetModule.id), sectionId, band });
  }

  function openEditEntry(question: Question) {
    const questionModule = library?.modules.find((item) => item.id === question.moduleId);
    setEntry({ draft: editableQuestionDraft(question, questionModule), sectionId: null, band: "example" });
  }

  function entrySaved(current: EntryState, saved: Question[]) {
    setLibrary((value) => value && { ...value, questions: [...saved, ...value.questions.filter((item) => !saved.some((entryQuestion) => entryQuestion.id === item.id))] });
    // Editing an existing question only refreshes it; anything newly created joins the handout.
    const created = saved.filter((question) => question.id !== current.draft.id);
    if (!created.length) return;
    writeStored(ENTRY_CATEGORY_KEY, created[0].categoryId);
    insertQuestions(created.map((question) => question.id), current.sectionId, current.band);
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
    } catch (error) { onNotice(error instanceof Error ? error.message : "识别失败，请重试"); }
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

  // PDF and LaTeX source share one generator; Word keeps the editable source format.
  async function exportHandout(kind: ExportFormat | "source") {
    if (!doc || exporting) return;
    setExporting(kind);
    try {
      const { modules, missingCount } = handoutSections(doc.items, (_scope, questionId) => resolve(questionId));
      const ids = [...new Set(doc.items.flatMap((item) => item.kind === "question" && resolve(item.questionId) ? [item.questionId] : []))];
      if (ids.length) await authorizeDownload(ids);
      const notes = missingCount ? [`跳过 ${missingCount} 道无法读取的题`] : [];
      if (kind === "word") {
        const { buildWordBlob, handoutWordSections } = await import("../../../lib/export-word");
        saveBlob(await buildWordBlob({ title: doc.title, sections: handoutWordSections(modules, answers), answers }), `${doc.title}.docx`);
        onNotice(["Word 已生成", ...notes].join("，"));
      } else {
        const { buildHandoutLatexProject, compileLatexPdf, latexSourceZip } = await import("../../../lib/handout-latex-files");
        const project = await buildHandoutLatexProject({ title: doc.title, modules, answers });
        if (project.missingFigures) notes.push(`${project.missingFigures} 张配图未能读取`);
        if (kind === "source") {
          saveBlob(await latexSourceZip(project), `${doc.title}-LaTeX.zip`);
          onNotice(["LaTeX 源码已下载", ...notes].join("，"));
        } else {
          const { pdf, issues } = await compileLatexPdf(project);
          saveBlob(pdf, `${doc.title}.pdf`);
          setLatexStatus((status) => status && { ...status, installed: true });
          onNotice(["PDF 已生成", ...(issues ? [`${issues} 处公式需要检查`] : []), ...notes].join("，"));
        }
      }
      setExportOpen(false);
    } catch (error) { onNotice(error instanceof Error ? error.message : "导出失败"); }
    finally { setExporting(null); }
  }

  if (missing) return <main className="toolbox handouts"><a className="toolbox-back" href="/tools/handouts"><HandoutIcon name="back" /><span>全部讲义</span></a><div className="handout-empty"><b>讲义不存在</b><p>它可能已被删除。</p></div></main>;
  if (!doc) return <main className="toolbox handouts"><p className="handout-muted">正在读取讲义…</p></main>;

  // Questions always sit in a module (see ensureLeadingModule), so only module cards are shown.
  const modules = handoutModules(doc.items).flatMap((module) => module.section ? [{ section: module.section, bands: module.bands }] : []);
  const activePicker: PickerMode = picker?.kind === "replace" && doc.items.some((item) => item.id === picker.itemId)
    ? picker
    : { kind: "add", sectionId: picker?.kind === "add" && modules.some(({ section }) => section.id === picker.sectionId) ? picker.sectionId : modules[0]?.section.id ?? null, band: picker?.kind === "add" ? picker.band : "example" };
  const numbers = handoutNumbers(doc.items);
  const taken = new Set(doc.items.flatMap((item) => item.kind === "question" ? [item.questionId] : []));
  const questionCount = doc.items.filter((item) => item.kind === "question").length;
  const missingCount = doc.items.filter((item) => item.kind === "question" && libraryReady && !resolve(item.questionId)).length;
  const saveLabel = { saved: "已保存", editing: "编辑中", saving: "保存中…", failed: "保存失败" }[saveState];

  const questionCard = (item: QuestionItem, band: HandoutBand, laneIndex: number, laneSize: number) => {
    const question = resolve(item.questionId);
    const label = numbers.get(item.id) ?? ""; const name = band === "practice" ? `练习 ${label}` : label;
    const points = question ? questionPoints(question) : [];
    return <article className="handout-question" key={item.id}>
      {question ? <QuestionBody question={question} number={label} /> : <p className="handout-missing">{libraryReady ? "原题已删除或无权访问，可替换或移出。" : "正在读取题目…"}</p>}
      {question && <div className="handout-points">{points.length
        ? <><span>考点</span>{points.map((point) => <b key={point}>{point}</b>)}</>
        : question.canEdit ? <button className="text-button" onClick={() => openEditEntry(question)}>未标知识点 · 补充</button> : <span>未标知识点</span>}</div>}
      <div className="handout-question-foot">
        <small>{question && library ? `${question.type} · ${categoryPath(library.modules, library.categories, question.categoryId)}` : ""}</small>
        <div className="handout-actions">
          <button aria-label={`${name} 上移`} disabled={laneIndex === 0} onClick={() => setItems(moveHandoutItem(doc.items, item.id, -1))}>↑</button>
          <button aria-label={`${name} 下移`} disabled={laneIndex === laneSize - 1} onClick={() => setItems(moveHandoutItem(doc.items, item.id, 1))}>↓</button>
          <button disabled={!libraryReady} onClick={() => choosePicker({ kind: "replace", itemId: item.id, label: `替换 ${name}` })}>替换</button>
          <PaperMoreMenu label="题目更多操作">
            {HANDOUT_BANDS.filter((other) => other !== band).map((other) => <button key={other} onClick={() => changeBand(item.id, other)}>改为{HANDOUT_PARTS[other].label}</button>)}
            {question?.canEdit && <button onClick={() => openEditEntry(question)}>编辑原题</button>}
            <button onClick={() => setItems(doc.items.filter((entryItem) => entryItem.id !== item.id))}>移出讲义</button>
          </PaperMoreMenu>
        </div>
      </div>
    </article>;
  };

  return <main className="toolbox handouts handout-editor">
    <div className="handout-workspace">
      <div className="handout-bank-pane" ref={bankPane}>
        <QuestionPicker library={library} mode={activePicker} taken={taken} onPick={(ids) => pick(ids, activePicker)} onModeChange={setPicker}
          sections={modules.map(({ section }, index) => ({ id: section.id, label: `模块${moduleHeading(section.title, index).numeral} · ${section.title || "未命名模块"}` }))}
          footer={<div className="handout-bar">
            <a className="handout-back" aria-label="全部讲义" href={home.grade ? `/tools/handouts?grade=${home.grade}` : "/tools/handouts"}><HandoutIcon name="back" /><span>全部讲义</span></a>
            <span className={`handout-save ${saveState}`} role="status">{saveLabel}{saveState === "failed" && <button className="text-button" onClick={() => void flush()}>重试</button>}</span>
            <button className="primary-button" disabled={!questionCount || !libraryReady} onClick={() => void openExport()}>导出</button>
          </div>} />
      </div>
      <div className="handout-draft" aria-label="讲义编辑">
    <input className="handout-title" aria-label="讲义标题" value={doc.title} onFocus={(event) => { if (event.target.value === DEFAULT_HANDOUT_TITLE) event.target.select(); }} onChange={(event) => edit({ title: event.target.value }, false)} onBlur={() => void flush()} />

    {modules.map(({ section, bands }, moduleIndex) => {
      const heading = moduleHeading(section.title, moduleIndex); const badge = `模块${heading.numeral}`;
      const hasNote = Boolean(section.note.trim());
      return <section className="handout-module" key={section.id} aria-label={badge}>
        <div className="handout-module-head">
          <span className="handout-module-badge">{badge}</span>
          <input aria-label={`${badge}名称`} value={section.title} placeholder="模块名称，如：平行四边形的性质" onChange={(event) => updateSection(section.id, { title: event.target.value })} onBlur={() => void flush()} />
          <div className="handout-actions">
            <button aria-label={`${badge}上移`} disabled={moduleIndex === 0} onClick={() => setItems(moveHandoutItem(doc.items, section.id, -1))}>↑</button>
            <button aria-label={`${badge}下移`} disabled={moduleIndex === modules.length - 1} onClick={() => setItems(moveHandoutItem(doc.items, section.id, 1))}>↓</button>
            <PaperMoreMenu label="模块更多操作"><button onClick={() => removeModule(section, HANDOUT_BANDS.flatMap((band) => bands[band]), heading.title || badge)}>删除模块</button></PaperMoreMenu>
          </div>
        </div>
        <p className="handout-module-status">
          <span className={hasNote ? "done" : ""}>知识点 {hasNote ? "✓" : "待补"}</span>
          {HANDOUT_BANDS.map((band) => <span key={band} className={bands[band].length ? "done" : ""}>{HANDOUT_PARTS[band].label} {bands[band].length}</span>)}
        </p>

        <div className={`handout-lane knowledge${dropNote === section.id ? " dropping" : ""}`}
          onPaste={(event) => { const file = clipboardImage(event); if (file) { event.preventDefault(); void importNoteScreenshot(section.id, file); } }}
          onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDropNote(section.id); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropNote(null); }}
          onDrop={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDropNote(null); const file = droppedImage(event); if (file) void importNoteScreenshot(section.id, file); else onNotice("请选择图片文件"); }}>
          <div className="handout-lane-head"><b>{HANDOUT_PARTS.knowledge.label}</b><span>{HANDOUT_PARTS.knowledge.tagline}</span>
            {dropNote === section.id ? <em>松开即可识别截图</em> : <button className="text-button" title="选择、拖入或粘贴知识点截图" disabled={Boolean(noteImport)} onClick={() => chooseNoteScreenshot(section.id)}>{noteImport === section.id ? "正在识别截图…" : "截图识别"}</button>}
          </div>
          <Suspense fallback={<div className="note-editor"><div className="note-editor-body"><NotePreview note={section.note} /></div></div>}>
            <NoteEditor value={section.note} label={`${badge}知识点`} placeholder={HANDOUT_PARTS.knowledge.hint} onChange={(note) => updateSection(section.id, { note })} onCommit={() => void flush()} />
          </Suspense>
        </div>

        {HANDOUT_BANDS.map((band) => {
          const part = HANDOUT_PARTS[band]; const lane = bands[band];
          return <div className={`handout-lane ${band}`} key={band}>
            <div className="handout-lane-head"><b>{part.label}</b><span>{part.tagline}</span></div>
            {lane.length ? lane.map((item, laneIndex) => questionCard(item, band, laneIndex, lane.length)) : <p className="handout-lane-hint">{part.hint}</p>}
            <div className="handout-add">
              <button className="secondary" disabled={!libraryReady} onClick={() => choosePicker({ kind: "add", sectionId: section.id, band })}>＋ 从题库选题</button>
              <button className="text-button" disabled={!libraryReady} onClick={() => openNewEntry(section.id, band)}>＋ 录入新题</button>
            </div>
          </div>;
        })}
      </section>;
    })}
    <button className="handout-add-section" onClick={() => setItems([...doc.items, { id: newId(), kind: "section", title: "", note: "" }])}>＋ 添加知识模块</button>

      </div>
    </div>

    <input ref={noteFile} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file && noteTarget.current) void importNoteScreenshot(noteTarget.current, file); event.target.value = ""; }} />
    {entry && library && <QuestionEntry initial={entry.draft} modules={library.modules} categories={library.categories}
      moduleIds={entry.draft.id ? [entry.draft.moduleId ?? ""] : library.modules.map((item) => item.id)}
      onSaved={(saved) => entrySaved(entry, saved)} onClose={() => setEntry(null)} onNotice={onNotice} />}
    {exportOpen && <div className="modal-backdrop"><section className="modal export-modal" role="dialog" aria-modal="true" aria-label="导出讲义">
      <div className="modal-head"><div><span className="eyebrow">导出 · {questionCount} 题</span><h2>{doc.title}</h2></div><button className="close" aria-label="关闭" disabled={Boolean(exporting)} onClick={() => setExportOpen(false)}>×</button></div>
      <fieldset className="handout-answer-choice" disabled={Boolean(exporting)}><legend>答案</legend>
        <div>{ANSWER_CHOICES.map((choice) => <label key={choice.value} className={answers === choice.value ? "active" : ""}><input type="radio" name="handout-answers" value={choice.value} checked={answers === choice.value} onChange={() => setAnswers(choice.value)} />{choice.label}</label>)}</div>
        <p>{ANSWER_CHOICES.find((choice) => choice.value === answers)?.hint}</p>
      </fieldset>
      {!!missingCount && <p className="handout-warning">有 {missingCount} 道题已无法读取，导出时会跳过。</p>}
      {latexStatus && !latexStatus.available ? <p className="handout-export-status">精排 PDF 需要在本机用「启动知题」运行时生成；这里可以导出 Word，或下载 LaTeX 源码自行编译。</p>
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
