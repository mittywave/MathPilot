"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authorizeDownload, createTypesetRecord, deleteTypesetRecord, fetchLibrary, fetchMe, fetchTypesetRecords, fetchTypesetSource, saveTypesetQuestions, updateTypesetRecord } from "../../../lib/api-client";
import { contentFingerprint } from "../../../lib/content-fingerprint.mjs";
import { questionCreationContent } from "../../../lib/question-create-rules.mjs";
import { createQuestionMatcher } from "../../../lib/question-identity";
import type { WordAnswerPlacement } from "../../../lib/export-word";
import type { SheetGroup } from "../../../lib/handout-latex";
import type { LatexStatus } from "../../../lib/handout-latex-files";
import { planDays, planQuestionIds } from "../../../lib/smart-paper-contract";
import type { AuthUser, Question, TypesetRecord, TypesetSettings } from "../../../lib/types";
import { SiteHeader } from "../../components/SiteHeader";
import { AssignHomework } from "../../components/AssignHomework";
import { PdfPreview } from "./PdfPreview";
import { TypesetHistory } from "./TypesetHistory";
import "../tools.css";
import "./typeset.css";

// 快速排版: a Word 练习 read by its own structure (as 录入 reads it) and typeset with the 练习 template of the 讲义 export.
// 组卷篮 and 智能组卷 open the same tool on their own questions, typeset as the library holds them, with no Word in between;
// 智能组卷 comes in days, each printed on its own pages. Its records reopen from the history by question ID.
const EDITIONS: { value: WordAnswerPlacement; label: string; hint: string }[] = [
  { value: "none", label: "学生版", hint: "只有题目" },
  { value: "end", label: "附答案", hint: "答案与解析放在文末" },
  { value: "each", label: "教师版", hint: "每题后紧跟答案" },
];

// The room after a question: a 解答题 leaves ruled answer lines, any other question blank millimetres.
type Unit = "行" | "mm";
const ROOM: Record<Unit, { name: string; fallback: number; step: number; max: number }> = {
  行: { name: "作答横线", fallback: 6, step: 1, max: 20 },
  mm: { name: "题后留白", fallback: 0, step: 2, max: 80 },
};
type Source = { fileName: string; questions: Question[]; units: Unit[]; groups?: SheetGroup[]; groupMode?: "sections" | "days" };
// The distance between answer lines, in millimetres; the template's default is 8.
const PITCH = { fallback: 8, min: 6, max: 12 };
type Result = { pdf: Blob; notes: string[] };
const groupKey = (question: Question, unit: Unit) => `${question.type}|${unit}`;

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Settings read back from a history record; anything missing or out of range falls back to the default.
function restoredSettings(raw: Partial<TypesetSettings>): TypesetSettings {
  const numbers = (value: unknown) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
  return {
    answers: raw.answers === "end" || raw.answers === "each" ? raw.answers : "none",
    showSource: raw.showSource === true,
    saveToLibrary: raw.saveToLibrary === true,
    linePitch: typeof raw.linePitch === "number" ? Math.min(PITCH.max, Math.max(PITCH.min, Math.round(raw.linePitch))) : PITCH.fallback,
    groupRoom: numbers(raw.groupRoom), ownRoom: numbers(raw.ownRoom),
  };
}

function TypesetIcon({ name }: { name: "upload" | "history" | "list" }) {
  const paths = {
    history: <><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3 4v4.5h4.5M12 7.5V12l3 2" /></>,
    list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
    upload: <><path d="M12 15V4m-4.5 4.5L12 4l4.5 4.5" /><path d="M4 14.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4.5" /></>,
  } as const;
  return <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

function Stepper({ value, unit, label, disabled, onChange, min = 0, max = ROOM[unit].max, step = ROOM[unit].step }: {
  value: number; unit: Unit; label: string; disabled?: boolean; onChange: (value: number) => void; min?: number; max?: number; step?: number;
}) {
  // Keep an unfinished edit local, so clearing a value or typing 12 is not interrupted by clamping.
  const [draft, setDraft] = useState<string | null>(null);
  const set = (next: number) => { if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next)))); };
  return <span className="typeset-stepper">
    <button type="button" aria-label={`${label}减少`} disabled={disabled || value <= min} onClick={() => set(value - step)}>−</button>
    <input type="number" inputMode="numeric" min={min} max={max} step={1} value={draft ?? String(value)} aria-label={label} disabled={disabled}
      onChange={(event) => { setDraft(event.target.value); if (event.target.value !== "") set(Number(event.target.value)); }}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    <button type="button" aria-label={`${label}增加`} disabled={disabled || value >= max} onClick={() => set(value + step)}>+</button>
    <em>{unit}</em>
  </span>;
}

// 组卷篮 (or 智能组卷) hands over its questions in order, its title and the settings it kept from the last time; closing
// hands the title and settings back. 智能组卷 also hands over its days, its history record, which keeps the settings,
// and the student it was made for, who is chosen first when the material is assigned.
export type BasketTypeset = {
  questions: Question[]; title: string; settings: Partial<TypesetSettings>; onClose: (title: string, settings: TypesetSettings) => void;
  onChange?: (title: string, settings: TypesetSettings) => void;
  groups?: SheetGroup[]; groupMode?: "sections" | "days"; recordId?: string; studentId?: string; origin?: { back: string; name: string; hint: string };
};
const BASKET_ORIGIN = { back: "← 组卷篮", name: "组卷篮", hint: "点击回组卷篮调整题目" };

// 第 2 天 第 3 题 in a material in days, otherwise 第 3 题.
function questionLabel(groups: SheetGroup[] | undefined, index: number, groupMode?: "sections" | "days") {
  let start = 0;
  for (const group of groups ?? []) {
    if (index < start + group.size) return `${groupMode === "sections" ? group.title : group.title.split(" · ")[0]} 第 ${groupMode === "sections" ? index + 1 : index - start + 1} 题`;
    start += group.size;
  }
  return `第 ${index + 1} 题`;
}

export default function Typesetter({ basket }: { basket?: BasketTypeset }) {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [status, setStatus] = useState<LatexStatus | null>(null);
  const statusRef = useRef<LatexStatus | null>(null);
  const statusReady = useRef<Promise<LatexStatus> | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [title, setTitle] = useState("");
  const [appliedTitle, setAppliedTitle] = useState("");
  const [answers, setAnswers] = useState<WordAnswerPlacement>("none");
  const [showSource, setShowSource] = useState(false);
  const [saveToLibrary, setSaveToLibrary] = useState(false);
  const [linePitch, setLinePitch] = useState(PITCH.fallback);
  const [groupRoom, setGroupRoom] = useState<Record<string, number>>({});
  const [ownRoom, setOwnRoom] = useState<Record<number, number>>({});
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pasteText, setPasteText] = useState<string | null>(null);
  // History: null when nobody is signed in. The open material saves into its record; saved holds what was last written.
  const [records, setRecords] = useState<TypesetRecord[] | null>(null);
  const [listedAt, setListedAt] = useState(0);
  const [recordId, setRecordId] = useState<string | null>(basket?.recordId ?? null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyNote, setHistoryNote] = useState("");
  // A 智能组卷 record opened from the history: its card leads back to 智能组卷 to change the questions.
  const [libraryRecord, setLibraryRecord] = useState<TypesetRecord | null>(null);
  // What the open record last saved; a 智能组卷 plan's record opens with the title and settings it was handed.
  const saved = useRef(basket?.recordId ? JSON.stringify({ title: basket.title, settings: restoredSettings(basket.settings) }) : "");
  const fileInput = useRef<HTMLInputElement>(null);
  const pasteInput = useRef<HTMLTextAreaElement>(null);
  const run = useRef(0);
  const [assigning, setAssigning] = useState(false);
  const closeAssign = useCallback(() => setAssigning(false), []);
  useEffect(() => { if (pasteText === "") pasteInput.current?.focus(); }, [pasteText]);

  useEffect(() => {
    statusReady.current = import("../../../lib/handout-latex-files").then(({ latexCompilerStatus }) => latexCompilerStatus())
      .then((value) => { statusRef.current = value; setStatus(value); return value; });
    // The basket's questions open at once. They stay in the basket and are not kept in the history; a 智能组卷 plan
    // brings its own record, and settings changed here are written to it.
    if (basket) { void show((basket.origin ?? BASKET_ORIGIN).name, basket.questions, basket.title, restoredSettings(basket.settings), basket.groups, basket.groupMode); return; }
    void fetchMe().then(({ user }) => setUser(user)).catch(() => { setUser(null); setHistoryNote("历史记录读取失败，请刷新重试。"); });
  // The basket is read once, when the tool opens; it is out of sight until the tool closes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh after assigning, opening the history or returning from the student archive (where homework can be cancelled).
  useEffect(() => {
    if (basket || !user || assigning) return;
    let current = true;
    const refresh = () => { void fetchTypesetRecords().then(({ records }) => {
      if (current) { setRecords(records); setListedAt(Date.now()); }
    }).catch(() => { if (current) setHistoryNote("历史记录读取失败，请刷新重试。"); }); };
    refresh(); window.addEventListener("focus", refresh);
    return () => { current = false; window.removeEventListener("focus", refresh); };
  }, [basket, user, showHistory, assigning]);

  const groups = useMemo(() => {
    const list: { key: string; type: string; unit: Unit; count: number }[] = [];
    source?.questions.forEach((question, index) => {
      const key = groupKey(question, source.units[index]);
      const group = list.find((item) => item.key === key);
      if (group) group.count += 1; else list.push({ key, type: question.type, unit: source.units[index], count: 1 });
    });
    return list;
  }, [source]);
  const roomOf = useCallback((index: number) => {
    if (!source) return 0;
    const unit = source.units[index];
    return ownRoom[index] ?? groupRoom[groupKey(source.questions[index], unit)] ?? ROOM[unit].fallback;
  }, [source, ownRoom, groupRoom]);
  const spacing = useMemo(() => source?.questions.map((_, index) => roomOf(index)) ?? [], [source, roomOf]);
  const spacingKey = spacing.join(",");

  const registerQuestions = useCallback(async (questions: Question[]) => {
    setError(""); setBusy("正在加入题库并分配 ID…");
    try {
      const saved = (await saveTypesetQuestions(questions)).questions;
      setResult(null);
      setSource((current) => current?.questions === questions ? { ...current, questions: saved } : current);
      return saved;
    } catch (reason) { setBusy(""); throw reason; }
  }, []);

  // Any change of file, title, edition or spacing typesets again; quick successive changes make one run.
  useEffect(() => {
    if (!source) return;
    const id = ++run.current;
    const timer = setTimeout(() => void (async () => {
      setError(""); setBusy(statusRef.current?.installed === false ? "首次排版：正在下载排版组件，约 1–2 分钟…" : "正在排版…");
      try {
        if (saveToLibrary && source.questions.some((question) => !question.code)) { await registerQuestions(source.questions); return; }
        if (!statusRef.current) await statusReady.current;
        const { buildHandoutLatexProject, compileLatexPdf } = await import("../../../lib/handout-latex-files");
        // The hosted site has no typesetter; the panel says so instead.
        if (!statusRef.current?.available) return;
        const project = await buildHandoutLatexProject({ title: appliedTitle || "练习", answers, showSource, sheet: "练习", questions: source.questions, spacing: spacingKey.split(",").map(Number), linePitch, groups: source.groups, groupMode: source.groupMode });
        const notes = project.missingFigures ? [`${project.missingFigures} 张配图未能读取`] : [];
        const { pdf, issues } = await compileLatexPdf(project);
        if (id !== run.current) return;
        if (issues) notes.push(`${issues} 处公式需要检查`);
        setResult({ pdf, notes });
        if (statusRef.current && !statusRef.current.installed) { statusRef.current = { ...statusRef.current, installed: true }; setStatus(statusRef.current); }
      } catch (reason) { if (id === run.current) setError(reason instanceof Error ? reason.message : "排版失败"); }
      finally { if (id === run.current) setBusy(""); }
    })(), 350);
    return () => clearTimeout(timer);
  }, [source, appliedTitle, answers, showSource, saveToLibrary, spacingKey, linePitch, registerQuestions]);

  // Puts a material on the page: its questions, with the title and the settings it opens with.
  async function show(fileName: string, questions: Question[], name: string, settings: TypesetSettings, groups?: SheetGroup[], groupMode?: "sections" | "days") {
    const { leavesAnswerLines } = await import("../../../lib/handout-latex");
    setTitle(name); setAppliedTitle(name); setAnswers(settings.answers); setLinePitch(settings.linePitch);
    setShowSource(settings.showSource === true);
    setSaveToLibrary(settings.saveToLibrary === true);
    setGroupRoom(settings.groupRoom); setOwnRoom(Object.fromEntries(Object.entries(settings.ownRoom).map(([index, value]) => [Number(index), value])));
    setSource({ fileName, questions, units: questions.map((question) => leavesAnswerLines(question) ? "行" : "mm"), groups, groupMode });
  }

  // A new file starts a record; a record from the history opens with the settings it was left with.
  async function openFile(file: File, record?: TypesetRecord) {
    if (!/\.docx$/i.test(file.name)) { setError(/\.doc$/i.test(file.name) ? "暂不支持旧版 .doc，请在 Word 中另存为 .docx" : "请选择 Word（.docx）文件"); return; }
    run.current += 1; setResult(null); setPicked(null); setError(""); setHistoryNote(""); setLibraryRecord(null); setBusy("正在读取 Word…");
    try {
      const { renderImportFile, structuredDocxQuestions } = await import("../../../lib/file-import");
      const items = structuredDocxQuestions(await renderImportFile(file, () => {}));
      if (!items.length) { setBusy(""); setSource(null); setError("没有从这份 Word 里读出题目。题目需要以「1.」「2.」这样的题号开头，大题用「一、选择题」这类标题；讲义也可以每题单独一行加粗标题，如「例题精练 1」。"); return; }
      // Content identities survive reopening the Word, retries and another browser, including plain-http LAN use.
      // This is only a candidate key: a printed code is shown only after the library confirms the saved original.
      const questions: Question[] = await Promise.all(items.map(async (item) => {
        const question: Question & { questionNumber?: string; warnings?: string[] } = { ...item, id: "", moduleId: "", categoryId: "", difficulty: "中等", source: "", createdAt: 0, updatedAt: 0 };
        delete question.questionNumber; delete question.warnings;
        question.id = `typeset-${await contentFingerprint(questionCreationContent(question), null)}`;
        return question;
      }));
      const library = (await fetchLibrary()).questions;
      const known = new Map(library.map((question) => [question.id, question]));
      const codes = new Map(library.map((question) => [question.code, question]));
      const matcher = createQuestionMatcher();
      for (const question of library) matcher.add(question.id, question);
      for (const question of questions) {
        const printed = codes.get(question.code);
        const original = known.get(question.id) ?? (printed && matcher.confirms(printed.id, question, false) ? printed : undefined);
        if (original) { question.id = original.id; question.code = original.code; } else delete question.code;
      }
      const name = record?.title ?? file.name.replace(/\.docx$/i, "").trim();
      const settings = record ? restoredSettings(record.settings) : { answers, showSource, saveToLibrary: false, linePitch, groupRoom: {}, ownRoom: {} };
      await show(file.name, questions, name, settings);
      setBusy(""); setShowHistory(false);
      saved.current = JSON.stringify({ title: name, settings });
      setRecordId(record?.id ?? null);
      if (record || records === null) return;
      try {
        const created = (await createTypesetRecord(file, { title: name, questionCount: questions.length, settings })).record;
        setRecordId(created.id); setRecords((current) => current && [created, ...current]); setListedAt(Date.now());
      } catch (reason) { setHistoryNote(`未保存到历史记录：${reason instanceof Error ? reason.message : "保存失败"}`); }
    } catch (reason) { setBusy(""); setError(reason instanceof Error ? reason.message : "Word 读取失败"); }
  }

  async function openPaste(html: string, text: string) {
    run.current += 1; setError(""); setBusy("正在读取粘贴内容…");
    try {
      const { clipboardWordFile } = await import("../../../lib/file-import");
      const file = await clipboardWordFile(html, text);
      await openFile(file); setPasteText(null);
    } catch (reason) { setBusy(""); if (html) setPasteText(""); setError(reason instanceof Error ? reason.message : "粘贴内容读取失败"); }
  }

  async function openRecord(record: TypesetRecord) {
    if (record.sourceKind === "library") { await openLibraryRecord(record); return; }
    setError(""); setBusy("正在打开…");
    try { await openFile(await fetchTypesetSource(record), record); }
    catch (reason) { setBusy(""); setError(reason instanceof Error ? reason.message : "打开失败"); }
  }

  // A 智能组卷 record: its questions are read from the library by ID, day by day; questions deleted since are skipped.
  async function openLibraryRecord(record: TypesetRecord) {
    run.current += 1; setResult(null); setPicked(null); setError(""); setHistoryNote(""); setBusy("正在从题库取题…");
    try {
      if (!record.plan) throw new Error("这条记录的题目清单已无法读取");
      const days = planDays(record.plan, new Map((await fetchLibrary()).questions.map((question) => [question.id, question])));
      const questions = days.flatMap((day) => day.questions);
      if (!questions.length) throw new Error("这份资料里的题都已不在题库中");
      await authorizeDownload(questions.map((question) => question.id));
      const settings = restoredSettings(record.settings);
      await show(`智能组卷${record.studentName ? ` · ${record.studentName}` : ""}`, questions, record.title, settings, days.map((day) => ({ title: day.title, size: day.questions.length })));
      setBusy(""); setShowHistory(false); setLibraryRecord(record);
      saved.current = JSON.stringify({ title: record.title, settings });
      setRecordId(record.id);
      const missing = planQuestionIds(record.plan).length - questions.length;
      if (missing) setHistoryNote(`有 ${missing} 道题已不在题库中，已跳过`);
    } catch (reason) { setBusy(""); setError(reason instanceof Error ? reason.message : "打开失败"); }
  }

  async function removeRecord(record: TypesetRecord) {
    try {
      await deleteTypesetRecord(record.id);
      setRecords((current) => current && current.filter((item) => item.id !== record.id));
      if (record.id === recordId) { setRecordId(null); setLibraryRecord(null); }
    } catch (reason) { setHistoryNote(reason instanceof Error ? reason.message : "删除失败"); }
  }

  // Every change of title, edition or spacing is written to the open record shortly after, which makes it the latest edit.
  const settingsKey = JSON.stringify({ title: appliedTitle, settings: { answers, showSource, saveToLibrary, linePitch, groupRoom, ownRoom } });
  // The paper basket keeps one local draft even while this overlay is open.
  const onBasketChange = basket?.onChange;
  useEffect(() => {
    if (source && onBasketChange) onBasketChange(title.trim(), (JSON.parse(settingsKey) as { settings: TypesetSettings }).settings);
  }, [source, title, settingsKey, onBasketChange]);
  useEffect(() => {
    if (!recordId || settingsKey === saved.current) return;
    const timer = setTimeout(() => {
      const { title: changedTitle, settings } = JSON.parse(settingsKey) as { title: string; settings: TypesetSettings };
      void updateTypesetRecord(recordId, { title: changedTitle || undefined, settings }).then(({ record }) => {
        saved.current = settingsKey;
        setRecords((current) => current && [record, ...current.filter((item) => item.id !== record.id)]); setListedAt(Date.now());
      }).catch((reason) => setHistoryNote(`历史记录未更新：${reason instanceof Error ? reason.message : "保存失败"}`));
    }, 1000);
    return () => clearTimeout(timer);
  }, [recordId, settingsKey]);
  // Back to 组卷篮, with the title as typed and the settings as they are now.
  const close = () => basket?.onClose(title.trim(), (JSON.parse(settingsKey) as { settings: TypesetSettings }).settings);

  const origin = basket?.origin ?? BASKET_ORIGIN;
  const days = source?.groups ? source.groupMode === "sections" ? ` · ${source.groups.length} 个大题` : ` · 分 ${source.groups.length} 天` : "";
  const teacher = answers === "each";
  const fileName = `${appliedTitle || "练习"}-${EDITIONS.find((item) => item.value === answers)!.label}`;
  const withAnswers = source?.questions.filter((question) => question.answer.trim() && question.answer !== "见解析" || question.analysis.trim()).length ?? 0;
  const own = Object.keys(ownRoom).map(Number).sort((a, b) => a - b);
  const setOwn = (index: number, value: number | null) => setOwnRoom((current) => {
    const next = { ...current };
    if (value === null) delete next[index]; else next[index] = value;
    return next;
  });

  const labelOf = (index: number) => questionLabel(source?.groups, index, source?.groupMode);
  const pickedPopover = source && picked !== null && (() => {
    const unit = source.units[picked]; const group = groupRoom[groupKey(source.questions[picked], unit)] ?? ROOM[unit].fallback;
    return <div className="typeset-popover" role="dialog" aria-label={`${labelOf(picked)}的留白`}>
      <header><b>{labelOf(picked)}</b><small>{source.questions[picked].type}</small>
        <button type="button" className="typeset-close" aria-label="关闭" onClick={() => setPicked(null)}>×</button></header>
      {teacher ? <p>教师版每题后紧跟答案，不留白。</p> : <>
        <label><span>{ROOM[unit].name}</span><Stepper value={roomOf(picked)} unit={unit} label={`${labelOf(picked)}${ROOM[unit].name}`} onChange={(value) => setOwn(picked, value)} /></label>
        {picked in ownRoom ? <button type="button" className="typeset-link" onClick={() => setOwn(picked, null)}>跟随{source.questions[picked].type}（{group} {unit}）</button>
          : <small>跟随{source.questions[picked].type}的设置</small>}
      </>}
    </div>;
  })();

  const historyToggle = records !== null && <button type="button" className={`secondary typeset-history-toggle${showHistory || !source ? " active" : ""}`} aria-pressed={showHistory || !source} onClick={() => setShowHistory((open) => source ? !open : false)}><TypesetIcon name="history" /><span>历史记录</span></button>;
  return <>{!basket && <SiteHeader active="tools" user={user ?? null} loading={user === undefined} trail={[{label:"工具箱",href:"/tools"},{label:"快速排版"}]} trailActions={historyToggle} />}<main className={`typeset${basket ? " typeset-overlay" : ""}`}>
    <aside className="typeset-panel" onPaste={(event) => {
      if (basket || busy || (event.target instanceof Element && event.target.closest("input,textarea,[contenteditable]"))) return;
      const html = event.clipboardData.getData("text/html"), text = event.clipboardData.getData("text/plain");
      if (html || text.trim()) { event.preventDefault(); void openPaste(html, text); }
    }}>
      {basket && <div className="typeset-top"><button type="button" className="secondary" onClick={close}>{origin.back}</button>{historyToggle}</div>}
      {basket ? <button type="button" className="typeset-drop loaded" onClick={close}>
        <TypesetIcon name="list" />
        <span><b>{origin.name}</b><small>{basket.questions.length} 道题{days}{withAnswers ? ` · ${withAnswers} 道带答案或解析` : ""} · {origin.hint}</small></span>
      </button> : libraryRecord && source ? <>
        <a className="typeset-drop loaded" href={`/tools/smart-paper?record=${encodeURIComponent(libraryRecord.id)}`}>
          <TypesetIcon name="list" />
          <span><b>{source.fileName}</b><small>{source.questions.length} 道题{days}{withAnswers ? ` · ${withAnswers} 道带答案或解析` : ""} · 点击回智能组卷调整题目</small></span>
        </a>
        <button type="button" className="typeset-link" onClick={() => fileInput.current?.click()}>改排一份 Word 练习</button>
      </> : <>
        <button className={`typeset-drop${dragging ? " dragging" : ""}${source ? " loaded" : ""}`} disabled={Boolean(busy)}
          onClick={() => fileInput.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void openFile(file); }}>
          <TypesetIcon name="upload" />
          {source ? <span><b>{source.fileName}</b><small>{source.questions.length} 道题{withAnswers ? ` · ${withAnswers} 道带答案或解析` : ""} · 点击换一份</small></span>
            : <span><b>选择或拖入 Word 练习</b><small>.docx，也可在这里按 ⌘V / Ctrl+V 粘贴网页题目</small></span>}
        </button>
      </>}
      {!basket && <input ref={fileInput} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void openFile(file); }} />}
      {!basket && <div className="typeset-paste">
        <button type="button" className="typeset-link" disabled={Boolean(busy)} aria-expanded={pasteText !== null} onClick={() => setPasteText(current => current === null ? "" : null)}>{pasteText === null ? "粘贴网页题目" : "收起粘贴"}</button>
        {pasteText !== null && <>
          <textarea ref={pasteInput} aria-label="网页题目" placeholder="复制网页中的题目，在这里按 ⌘V / Ctrl+V，粘贴后自动排版。" value={pasteText} disabled={Boolean(busy)} onChange={(event) => setPasteText(event.target.value)}
            onPaste={(event) => { event.preventDefault(); if (busy) return; const html = event.clipboardData.getData("text/html"), text = event.clipboardData.getData("text/plain"); setPasteText(text); void openPaste(html, text); }} />
          <small>支持文字、公式、表格和可读取的网页配图。多道题请保留题号。</small>
          <button type="button" className="secondary" disabled={Boolean(busy) || !pasteText.trim()} onClick={() => void openPaste("", pasteText)}>开始排版</button>
        </>}
      </div>}

      <label className="typeset-field"><span>标题</span>
        <input value={title} disabled={!source} placeholder="练习标题" onChange={(event) => setTitle(event.target.value)}
          onBlur={() => setAppliedTitle(title.trim())} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        <small>写成「第3讲 一元二次方程」时，「第3讲」会放进标题上方的标签。</small>
      </label>
      <div className="typeset-field"><span>版本</span>
        <div className="typeset-editions" role="radiogroup" aria-label="版本">{EDITIONS.map((item) => <label key={item.value} title={item.hint} className={answers === item.value ? "active" : ""}>
          <input type="radio" name="edition" checked={answers === item.value} onChange={() => setAnswers(item.value)} /><b>{item.label}</b>
        </label>)}</div>
        <div className="typeset-options">
          <label><input type="checkbox" checked={showSource} disabled={!source} onChange={(event) => setShowSource(event.target.checked)} /><span>显示题目来源</span></label>
          <label title="勾选后加入题库并在 PDF 印上永久 ID；取消勾选不会删除已入库题目。"><input type="checkbox" checked={saveToLibrary} disabled={!source || Boolean(busy)} onChange={(event) => { setSaveToLibrary(event.target.checked); if (event.target.checked) { setResult(null); setBusy("正在加入题库并分配 ID…"); } }} /><span>加入题库并分配 ID</span></label>
        </div>
        <small>布置给学生时自动加入题库，已有题目保留原 ID。</small>
      </div>

      {source && <section className="typeset-field" aria-label="间距"><span>间距</span>
        {teacher ? <small>教师版每题后紧跟答案，不留白；切到学生版或附答案可以调整。</small> : <>
          <ul className="typeset-rooms">
            {source.units.includes("行") && <li>
              <span><b>横线行距</b><small>作答横线之间的距离</small></span>
              <Stepper value={linePitch} unit="mm" label="横线行距" min={PITCH.min} max={PITCH.max} step={1} onChange={setLinePitch} />
            </li>}
            {groups.map((group) => <li key={group.key}>
            <span><b>{group.type}</b><small>{group.count} 道 · {ROOM[group.unit].name}</small></span>
            <Stepper value={groupRoom[group.key] ?? ROOM[group.unit].fallback} unit={group.unit} label={`${group.type}${ROOM[group.unit].name}`}
              onChange={(value) => setGroupRoom((current) => ({ ...current, [group.key]: value }))} />
          </li>)}
          </ul>
          {own.length ? <div className="typeset-own" aria-label="单独调整的题">{own.map((index) => <span key={index}>
            <button type="button" onClick={() => setPicked(index)}>{labelOf(index)} {ownRoom[index]} {source.units[index]}</button>
            <button type="button" aria-label={`${labelOf(index)}跟随题型`} onClick={() => setOwn(index, null)}>×</button>
          </span>)}</div> : null}
        </>}
      </section>}

      <div className="typeset-actions">
      <button className="primary-button typeset-download" aria-describedby={!source&&!basket&&!busy?"typeset-missing":undefined} disabled={!result || Boolean(busy)} onClick={() => result && saveBlob(result.pdf, `${fileName}.pdf`)}>下载 PDF</button>
      {(basket || records !== null) && <button type="button" className="secondary typeset-assign" aria-describedby={!source&&!basket&&!busy?"typeset-missing":undefined} disabled={!source || Boolean(busy)} onClick={() => setAssigning(true)}>布置给学生</button>}
      {!source&&!basket&&!busy&&<p className="missing-reason" id="typeset-missing">还差：<button type="button" className="text-button" onClick={()=>{const control=document.querySelector<HTMLButtonElement>(".typeset-panel button.typeset-drop");control?.focus({preventScroll:true});control?.scrollIntoView({block:"nearest"});}}>一份 Word 练习或网页题目</button></p>}
      {status && !status.available && <p className="typeset-note">PDF 需要在运行 MathPilot 的这台电脑上生成。</p>}
      {status?.available && !status.installed && !result && <p className="typeset-note">首次排版会下载排版组件（约 25MB）和所需宏包，约 1–2 分钟，之后几秒完成。</p>}
      {result?.notes.map((note) => <p key={note} className="typeset-note warn">{note}</p>)}
      {historyNote && <p className="typeset-note warn">{historyNote}</p>}
      {error && <p className="typeset-note error" role="alert">{error}</p>}
      </div>
    </aside>
      {assigning && source && <AssignHomework title={appliedTitle || title || "练习"} questions={source.questions} groups={source.groupMode === "sections" ? undefined : source.groups} studentId={basket?.studentId ?? libraryRecord?.studentId} recordId={recordId} onClose={closeAssign}
        prepareQuestions={async () => { const questions = await registerQuestions(source.questions); setSaveToLibrary(true); return questions; }} />}

    <section className="typeset-preview" aria-label={records !== null && (showHistory || !source) ? "历史记录" : "PDF 预览"} aria-busy={Boolean(busy)}>
      {records !== null && (showHistory || !source && !busy) ? <TypesetHistory records={records} current={recordId} now={listedAt} busy={Boolean(busy)}
        onOpen={(record) => void openRecord(record)} onDelete={(record) => void removeRecord(record)} onClose={source ? () => setShowHistory(false) : undefined} />
        : result && source ? <PdfPreview pdf={result.pdf} count={source.questions.length} picked={picked} onPick={setPicked} popover={pickedPopover}
        label={(index) => `${labelOf(index)} · ${teacher ? "教师版不留白" : `${ROOM[source.units[index]].name} ${roomOf(index)} ${source.units[index]}${index in ownRoom ? "（单独）" : ""}`}`} />
        : <div className="typeset-empty">
          {busy ? <><i className="typeset-spinner" /><b>{busy}</b></> : <><b>PDF 预览</b><p>{!source && !basket ? "选择 Word 练习或粘贴网页题目，排好的 PDF 会显示在这里。" : status && !status.available ? "这里无法生成 PDF，请在运行 MathPilot 的这台电脑上打开。" : "排好的 PDF 会显示在这里。"}</p></>}
        </div>}
      {busy && result && <div className="typeset-busy"><i className="typeset-spinner" />{busy}</div>}
    </section>
  </main></>;
}
