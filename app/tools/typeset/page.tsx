"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WordAnswerPlacement } from "../../../lib/export-word";
import type { LatexProject, LatexStatus } from "../../../lib/handout-latex-files";
import type { Question } from "../../../lib/types";
import { PdfPreview } from "./PdfPreview";
import "../tools.css";
import "./typeset.css";

// 快速排版: a Word 练习 read by its own structure (as 录入 reads it) and typeset with the 练习 template of the 讲义 export.
const EDITIONS: { value: WordAnswerPlacement; label: string; hint: string }[] = [
  { value: "none", label: "学生版", hint: "只有题目" },
  { value: "end", label: "附答案", hint: "答案与解析放在文末" },
  { value: "each", label: "教师版", hint: "每题后紧跟答案" },
];

// The room after a question: a 解答题 leaves ruled answer lines, any other question blank millimetres.
type Unit = "行" | "mm";
const ROOM: Record<Unit, { name: string; fallback: number; step: number; max: number }> = {
  行: { name: "作答横线", fallback: 4, step: 1, max: 15 },
  mm: { name: "题后留白", fallback: 0, step: 2, max: 80 },
};
type Source = { fileName: string; questions: Question[]; units: Unit[] };
type Result = { pdf: Blob | null; project: LatexProject; notes: string[] };
const groupKey = (question: Question, unit: Unit) => `${question.type}|${unit}`;

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function TypesetIcon({ name }: { name: "back" | "upload" }) {
  const paths = {
    back: <path d="m10 5-7 7 7 7M3 12h18" />,
    upload: <><path d="M12 15V4m-4.5 4.5L12 4l4.5 4.5" /><path d="M4 14.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4.5" /></>,
  } as const;
  return <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

function Stepper({ value, unit, label, disabled, onChange }: { value: number; unit: Unit; label: string; disabled?: boolean; onChange: (value: number) => void }) {
  const { step, max } = ROOM[unit];
  const set = (next: number) => { if (Number.isFinite(next)) onChange(Math.min(max, Math.max(0, Math.round(next)))); };
  return <span className="typeset-stepper">
    <button type="button" aria-label={`${label}减少`} disabled={disabled || value <= 0} onClick={() => set(value - step)}>−</button>
    <input type="number" inputMode="numeric" min={0} max={max} step={1} value={value} aria-label={label} disabled={disabled}
      onChange={(event) => { if (event.target.value !== "") set(Number(event.target.value)); }} />
    <button type="button" aria-label={`${label}增加`} disabled={disabled || value >= max} onClick={() => set(value + step)}>+</button>
    <em>{unit}</em>
  </span>;
}

export default function TypesetPage() {
  const [status, setStatus] = useState<LatexStatus | null>(null);
  const statusRef = useRef<LatexStatus | null>(null);
  const statusReady = useRef<Promise<LatexStatus> | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [title, setTitle] = useState("");
  const [appliedTitle, setAppliedTitle] = useState("");
  const [answers, setAnswers] = useState<WordAnswerPlacement>("none");
  const [groupRoom, setGroupRoom] = useState<Record<string, number>>({});
  const [ownRoom, setOwnRoom] = useState<Record<number, number>>({});
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const run = useRef(0);

  useEffect(() => {
    statusReady.current = import("../../../lib/handout-latex-files").then(({ latexCompilerStatus }) => latexCompilerStatus())
      .then((value) => { statusRef.current = value; setStatus(value); return value; });
  }, []);

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

  // Any change of file, title, edition or spacing typesets again; quick successive changes make one run.
  useEffect(() => {
    if (!source) return;
    const id = ++run.current;
    const timer = setTimeout(() => void (async () => {
      setError(""); setBusy(statusRef.current?.installed === false ? "首次排版：正在下载排版组件，约 1–2 分钟…" : "正在排版…");
      try {
        if (!statusRef.current) await statusReady.current;
        const { buildHandoutLatexProject, compileLatexPdf } = await import("../../../lib/handout-latex-files");
        const project = await buildHandoutLatexProject({ title: appliedTitle || "练习", answers, sheet: "练习", questions: source.questions, spacing: spacingKey.split(",").map(Number) });
        const notes = project.missingFigures ? [`${project.missingFigures} 张配图未能读取`] : [];
        // Without the local typesetter (the hosted site) only the TeX source can be offered.
        if (!statusRef.current?.available) { if (id === run.current) setResult({ pdf: null, project, notes }); return; }
        const { pdf, issues } = await compileLatexPdf(project);
        if (id !== run.current) return;
        if (issues) notes.push(`${issues} 处公式需要检查`);
        setResult({ pdf, project, notes });
        if (statusRef.current && !statusRef.current.installed) { statusRef.current = { ...statusRef.current, installed: true }; setStatus(statusRef.current); }
      } catch (reason) { if (id === run.current) setError(reason instanceof Error ? reason.message : "排版失败"); }
      finally { if (id === run.current) setBusy(""); }
    })(), 350);
    return () => clearTimeout(timer);
  }, [source, appliedTitle, answers, spacingKey]);

  async function openFile(file: File) {
    if (!/\.docx$/i.test(file.name)) { setError(/\.doc$/i.test(file.name) ? "暂不支持旧版 .doc，请在 Word 中另存为 .docx" : "请选择 Word（.docx）文件"); return; }
    run.current += 1; setResult(null); setPicked(null); setError(""); setBusy("正在读取 Word…");
    try {
      const [{ renderImportFile, structuredDocxQuestions }, { leavesAnswerLines }] = await Promise.all([import("../../../lib/file-import"), import("../../../lib/handout-latex")]);
      const items = structuredDocxQuestions(await renderImportFile(file, () => {}));
      setBusy("");
      if (!items.length) { setSource(null); setError("没有从这份 Word 里读出题目。题目需要以「1.」「2.」这样的题号开头，大题用「一、选择题」这类标题。"); return; }
      // The questions are only typeset, never saved, so they carry no library fields.
      const questions: Question[] = items.map(({ questionNumber, ...item }) => ({ ...item, id: `typeset-${questionNumber}`, categoryId: "", difficulty: "中等", source: "", createdAt: 0, updatedAt: 0 }));
      const name = file.name.replace(/\.docx$/i, "").trim();
      setTitle(name); setAppliedTitle(name); setGroupRoom({}); setOwnRoom({});
      setSource({ fileName: file.name, questions, units: questions.map((question) => leavesAnswerLines(question) ? "行" : "mm") });
    } catch (reason) { setBusy(""); setError(reason instanceof Error ? reason.message : "Word 读取失败"); }
  }

  const teacher = answers === "each";
  const fileName = `${appliedTitle || "练习"}-${EDITIONS.find((item) => item.value === answers)!.label}`;
  const withAnswers = source?.questions.filter((question) => question.answer.trim() && question.answer !== "见解析" || question.analysis.trim()).length ?? 0;
  const own = Object.keys(ownRoom).map(Number).sort((a, b) => a - b);
  const setOwn = (index: number, value: number | null) => setOwnRoom((current) => {
    const next = { ...current };
    if (value === null) delete next[index]; else next[index] = value;
    return next;
  });

  async function downloadSource() {
    if (!result) return;
    const { latexSourceZip } = await import("../../../lib/handout-latex-files");
    saveBlob(await latexSourceZip(result.project), `${fileName}-LaTeX.zip`);
  }

  const pickedPopover = source && picked !== null && (() => {
    const unit = source.units[picked]; const group = groupRoom[groupKey(source.questions[picked], unit)] ?? ROOM[unit].fallback;
    return <div className="typeset-popover" role="dialog" aria-label={`第 ${picked + 1} 题的留白`}>
      <header><b>第 {picked + 1} 题</b><small>{source.questions[picked].type}</small>
        <button type="button" className="typeset-close" aria-label="关闭" onClick={() => setPicked(null)}>×</button></header>
      {teacher ? <p>教师版每题后紧跟答案，不留白。</p> : <>
        <label><span>{ROOM[unit].name}</span><Stepper value={roomOf(picked)} unit={unit} label={`第 ${picked + 1} 题${ROOM[unit].name}`} onChange={(value) => setOwn(picked, value)} /></label>
        {picked in ownRoom ? <button type="button" className="typeset-link" onClick={() => setOwn(picked, null)}>跟随{source.questions[picked].type}（{group} {unit}）</button>
          : <small>跟随{source.questions[picked].type}的设置</small>}
      </>}
    </div>;
  })();

  return <main className="typeset">
    <aside className="typeset-panel">
      <a className="toolbox-back" href="/tools"><TypesetIcon name="back" /><span>工具箱 · 快速排版</span></a>
      <button className={`typeset-drop${dragging ? " dragging" : ""}${source ? " loaded" : ""}`} disabled={busy === "正在读取 Word…"}
        onClick={() => fileInput.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void openFile(file); }}>
        <TypesetIcon name="upload" />
        {source ? <span><b>{source.fileName}</b><small>{source.questions.length} 道题{withAnswers ? ` · ${withAnswers} 道带答案或解析` : ""} · 点击换一份</small></span>
          : <span><b>选择或拖入 Word 练习</b><small>.docx，按题号读出题目、配图、答案与解析</small></span>}
      </button>
      <input ref={fileInput} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void openFile(file); }} />

      <label className="typeset-field"><span>标题</span>
        <input value={title} disabled={!source} placeholder="练习标题" onChange={(event) => setTitle(event.target.value)}
          onBlur={() => setAppliedTitle(title.trim())} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        <small>写成「第3讲 一元二次方程」时，「第3讲」会放进标题上方的标签。</small>
      </label>
      <div className="typeset-field" role="radiogroup" aria-label="版本"><span>版本</span>
        <div className="typeset-editions">{EDITIONS.map((item) => <label key={item.value} className={answers === item.value ? "active" : ""}>
          <input type="radio" name="edition" checked={answers === item.value} onChange={() => setAnswers(item.value)} /><b>{item.label}</b><small>{item.hint}</small>
        </label>)}</div>
      </div>

      {source && <section className="typeset-field" aria-label="间距"><span>间距</span>
        {teacher ? <small>教师版每题后紧跟答案，不留白；切到学生版或附答案可以调整。</small> : <>
          <ul className="typeset-rooms">{groups.map((group) => <li key={group.key}>
            <span><b>{group.type}</b><small>{group.count} 道 · {ROOM[group.unit].name}</small></span>
            <Stepper value={groupRoom[group.key] ?? ROOM[group.unit].fallback} unit={group.unit} label={`${group.type}${ROOM[group.unit].name}`}
              onChange={(value) => setGroupRoom((current) => ({ ...current, [group.key]: value }))} />
          </li>)}</ul>
          {own.length ? <div className="typeset-own" aria-label="单独调整的题">{own.map((index) => <span key={index}>
            <button type="button" onClick={() => setPicked(index)}>第 {index + 1} 题 {ownRoom[index]} {source.units[index]}</button>
            <button type="button" aria-label={`第 ${index + 1} 题跟随题型`} onClick={() => setOwn(index, null)}>×</button>
          </span>)}</div> : null}
          <small>在预览里点一道题，可以单独调整它的留白。</small>
        </>}
      </section>}

      <div className="typeset-actions">
        <button className="primary-button" disabled={!result?.pdf || Boolean(busy)} onClick={() => result?.pdf && saveBlob(result.pdf, `${fileName}.pdf`)}>下载 PDF</button>
        <button className="secondary" disabled={!result || Boolean(busy)} onClick={() => void downloadSource()}>下载 TeX 源码</button>
      </div>
      {status && !status.available && <p className="typeset-note">PDF 需要在本机用「启动知题」运行时生成；这里可以下载 TeX 源码自行编译。</p>}
      {status?.available && !status.installed && !result && <p className="typeset-note">首次排版会下载排版组件（约 25MB）和所需宏包，约 1–2 分钟，之后几秒完成。</p>}
      {result?.notes.map((note) => <p key={note} className="typeset-note warn">{note}</p>)}
      {error && <p className="typeset-note error" role="alert">{error}</p>}
    </aside>

    <section className="typeset-preview" aria-label="PDF 预览" aria-busy={Boolean(busy)}>
      {result?.pdf && source ? <PdfPreview pdf={result.pdf} count={source.questions.length} picked={picked} onPick={setPicked} popover={pickedPopover}
        label={(index) => `第 ${index + 1} 题 · ${teacher ? "教师版不留白" : `${ROOM[source.units[index]].name} ${roomOf(index)} ${source.units[index]}${index in ownRoom ? "（单独）" : ""}`}`} />
        : <div className="typeset-empty">
          {busy ? <><i className="typeset-spinner" /><b>{busy}</b></> : <><b>PDF 预览</b><p>{result ? "这里无法生成 PDF，请下载 TeX 源码。" : "选择一份 Word 练习，排好的 PDF 会显示在这里。"}</p></>}
        </div>}
      {busy && result?.pdf && <div className="typeset-busy"><i className="typeset-spinner" />{busy}</div>}
    </section>
  </main>;
}
