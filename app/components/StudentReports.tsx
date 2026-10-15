"use client";

import { useEffect, useRef, useState } from "react";
import { useConfirm } from "./ConfirmDialog";
import { PaperMoreMenu } from "./PaperMoreMenu";
import { createStudentReport, deleteStudentReport, fetchStudentReports, updateStudentReport } from "../../lib/api-client";
import { ABILITY_DIMENSIONS, abilityStateLabel, reportKnowledgePoints, reportTotals } from "../../lib/student-profile-contract";
import type { StudentReport, StudentReportText, StudentSummary } from "../../lib/types";

const DAY = 86_400_000;
const day = (time: number) => new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
const period = (report: Pick<StudentReport, "periodStart" | "periodEnd">) => `${day(report.periodStart)}—${day(report.periodEnd)}`;
const dateValue = (time: number) => { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
// A period covers whole days: from the first day's start to the last day's end, in local time.
const dayStart = (value: string) => { const [year, month, date] = value.split("-").map(Number); return new Date(year, month - 1, date).getTime(); };
const dayEnd = (value: string) => dayStart(value) + DAY - 1;

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// A field of the report's text that grows with its content and saves when the teacher leaves it.
function TextField({ label, value, rows = 3, onSave }: { label: string; value: string; rows?: number; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (value !== shown) { setShown(value); setDraft(value); }
  return <label className="report-field"><span>{label}</span>
    <textarea rows={rows} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onSave(draft); }} />
  </label>;
}

function ReportView({ report, studentName, onChange, onRemove }: { report: StudentReport; studentName: string; onChange: (report: StudentReport) => void; onRemove: () => void }) {
  const [confirmNode, confirm] = useConfirm();
  const [state, setState] = useState("");
  const [busy, setBusy] = useState(false);
  const totals = reportTotals(report.data);
  const points = reportKnowledgePoints(report.data).slice(0, 12);
  const saving = useRef(Promise.resolve());

  function save(change: Partial<StudentReportText>) {
    const text = { ...report.text, ...change };
    onChange({ ...report, text });
    setState("正在保存…");
    // Edits save in order, so a quick second edit never lands before the first.
    saving.current = saving.current.then(() => updateStudentReport(report.studentId, report.id, text))
      .then(() => setState("已保存"), (reason) => setState(reason instanceof Error ? `没有保存：${reason.message}` : "没有保存"));
  }

  async function download(kind: "pdf" | "tex") {
    setBusy(true); setState("");
    try {
      await saving.current;
      const { buildStudentReportLatex, HOMEWORK_REPORT_MAIN } = await import("../../lib/homework-report-latex");
      const tex = buildStudentReportLatex(report);
      const name = `${studentName}-学情报告-${period(report).replace(/[/—]/g, "-")}`;
      if (kind === "tex") { saveBlob(new Blob([tex], { type: "application/x-tex" }), `${name}.tex`); return; }
      const { compileLatexPdf, latexCompilerStatus } = await import("../../lib/handout-latex-files");
      if (!(await latexCompilerStatus()).available) { setState("这台设备无法排版 PDF，可以下载 TeX，或在运行 MathPilot 的电脑上打开本页"); return; }
      setState("正在排版…");
      const { pdf, issues } = await compileLatexPdf({ main: HOMEWORK_REPORT_MAIN, files: { [HOMEWORK_REPORT_MAIN]: new TextEncoder().encode(tex) }, missingFigures: 0 });
      saveBlob(pdf, `${name}.pdf`);
      setState(issues ? `PDF 已生成，${issues} 处公式需要检查` : "PDF 已生成");
    } catch (reason) { setState(reason instanceof Error ? reason.message : "PDF 生成失败"); }
    finally { setBusy(false); }
  }

  return <article className="report-view" aria-label={`${period(report)}学情报告`}>
    {confirmNode}
    <header>
      <div><h3>{studentName} · {period(report)}</h3><small>{new Date(report.createdAt).toLocaleDateString("zh-CN")} 生成{state && ` · ${state}`}</small></div>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void download("pdf")}>{busy ? "正在排版…" : "下载 PDF"}</button>
      <PaperMoreMenu label="这份报告的操作">
        <button type="button" onClick={() => void download("tex")}>下载 TeX</button>
        <hr /><button type="button" className="danger-text" onClick={async () => { if (await confirm({ title: "删除这份学情报告", body: "删除后无法恢复。", confirmLabel: "删除", danger: true })) onRemove(); }}>删除…</button>
      </PaperMoreMenu>
    </header>
    <dl className="report-banner">
      <div><dt>作业</dt><dd>{totals.homework} 份</dd></div><div><dt>批改题数</dt><dd>{totals.total} 题</dd></div>
      <div><dt>正确率</dt><dd>{totals.total ? totals.rate : "—"}</dd></div><div><dt>课后反馈</dt><dd>{totals.lessons} 次</dd></div>
    </dl>
    <TextField label="总体情况" value={report.text.overview} onSave={(overview) => save({ overview })} />
    <section className="report-data"><h4>作业情况</h4>
      {report.data.homework.length ? <table><thead><tr><th>作业</th><th>日期</th><th>完成</th><th>对 / 错</th></tr></thead><tbody>
        {report.data.homework.map((item, index) => <tr key={index}><td>{item.title}</td><td>{day(item.createdAt)} {item.assigned ? "布置" : "批改"}</td><td>{item.assigned ? `${item.done}/${item.total} 题` : `${item.done} 题`}</td><td>{item.correct} / {item.incorrect}{item.pending ? `（待核 ${item.pending}）` : ""}</td></tr>)}
      </tbody></table> : <p>这段时间没有作业记录。</p>}
      {report.data.wrongAdded > 0 && <small>这段时间新进错题本 {report.data.wrongAdded} 题。</small>}
    </section>
    <TextField label="知识掌握" value={report.text.knowledge} rows={4} onSave={(knowledge) => save({ knowledge })} />
    {points.length > 0 && <section className="report-data"><table><thead><tr><th>知识点（正确率从低到高）</th><th>做题</th><th>做对</th><th>正确率</th></tr></thead><tbody>
      {points.map((item) => { const total = item.correct + item.partial + item.incorrect; return <tr key={item.key}><td>{item.label}</td><td>{total}</td><td>{item.correct}</td><td>{Math.round(item.correct / total * 100)}%</td></tr>; })}
    </tbody></table></section>}
    <TextField label="能力表现" value={report.text.abilities} onSave={(abilities) => save({ abilities })} />
    <section className="report-data"><table><thead><tr><th>能力</th><th>老师的判断</th><th>最近一次反馈</th></tr></thead><tbody>
      {ABILITY_DIMENSIONS.map((dimension) => {
        const notes = report.data.observations.flatMap((item) => item.abilities.filter((note) => note.key === dimension.key).map((note) => ({ ...note, at: item.observedAt })));
        const weak = notes.filter((note) => note.polarity === "weakness").length, strong = notes.length - weak; const latest = notes.at(-1);
        return <tr key={dimension.key}><td>{dimension.label}</td><td>{!notes.length ? "没提到" : weak && strong ? `短板 ${weak} 次 · ${abilityStateLabel(dimension.key, "strength")} ${strong} 次` : abilityStateLabel(dimension.key, weak ? "weakness" : "strength")}</td><td>{latest ? `“${latest.evidence}”（${day(latest.at)}）` : ""}</td></tr>;
      })}
    </tbody></table></section>
    <div className="report-field"><span>下一步安排</span>
      <ol className="report-plan">{[...report.text.plan, ""].map((item, index) => <li key={`${index}-${report.text.plan.length}`}>
        <TextField label={`第 ${index + 1} 条`} value={item} rows={1} onSave={(value) => save({ plan: Object.assign([...report.text.plan], { [index]: value }).map((line) => line.trim()).filter(Boolean) })} />
      </li>)}</ol>
    </div>
    <TextField label="给家长的话" value={report.text.message} rows={2} onSave={(message) => save({ message })} />
  </article>;
}

/** 学生档案 · 学情报告: reports for parents, each over a period, written from the archive and edited by the teacher. */
export function StudentReports({ student }: { student: StudentSummary }) {
  const [loaded, setLoaded] = useState<{ studentId: string; reports: StudentReport[] | null; error: string } | null>(null);
  const [selected, setSelected] = useState("");
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [today] = useState(() => Date.now());
  useEffect(() => {
    let current = true;
    fetchStudentReports(student.id).then((result) => { if (current) setLoaded({ studentId: student.id, reports: result.reports, error: "" }); })
      .catch((reason) => { if (current) setLoaded({ studentId: student.id, reports: null, error: reason instanceof Error ? reason.message : "学情报告读取失败" }); });
    return () => { current = false; };
  }, [student.id]);
  const reports = loaded?.studentId === student.id ? loaded.reports : null;
  const error = loaded?.studentId === student.id ? loaded.error : "";
  // The next report starts the day after the last one ended; the first one (or one made again the same day) covers 30 days.
  const nextStart = (reports?.[0]?.periodEnd ?? 0) + 1;
  const suggested = { from: dateValue(nextStart > 1 && dayStart(dateValue(nextStart)) <= today ? nextStart : today - 29 * DAY), to: dateValue(today) };
  const { from, to } = range ?? suggested;
  const shown = reports?.find((item) => item.id === selected) ?? reports?.[0] ?? null;
  const setReports = (change: (items: StudentReport[]) => StudentReport[]) => setLoaded((current) => current?.reports ? { ...current, reports: change(current.reports) } : current);

  async function generate() {
    if (busy || !from || !to || dayStart(from) > dayStart(to)) return;
    setBusy(true); setNotice("");
    try {
      const result = await createStudentReport(student.id, { periodStart: dayStart(from), periodEnd: dayEnd(to), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      setReports((items) => [result.report, ...items].sort((a, b) => b.periodEnd - a.periodEnd || b.createdAt - a.createdAt));
      setSelected(result.report.id); setRange(null); setNotice(result.notice);
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : "生成失败"); }
    finally { setBusy(false); }
  }

  return <section className="student-reports" aria-label={`${student.name}的学情报告`}>
    <header className="student-panel-head report-generate">
      <label>从<input type="date" value={from} max={to} onChange={(event) => setRange({ from: event.target.value, to })} /></label>
      <label>到<input type="date" value={to} min={from} max={dateValue(today)} onChange={(event) => setRange({ from, to: event.target.value })} /></label>
      <button type="button" className="primary-button" disabled={busy || !from || !to} onClick={() => void generate()}>{busy ? "AI 正在写报告…" : "生成学情报告"}</button>
      <small>汇总这段时间的作业、知识点和课后反馈，AI 写成给家长看的报告，可以修改后下载 PDF。</small>
    </header>
    {notice && <p className="observation-notice" role="status">{notice}</p>}
    {error ? <p className="student-panel-empty" role="alert">{error}</p> : !reports ? <div className="wrong-book-loading"><i></i><span>正在读取学情报告…</span></div>
      : !reports.length ? <div className="student-panel-empty"><b>还没有学情报告</b><p>选好时间段点“生成学情报告”。报告里的数字都来自这段时间批改过的作业，能力表现只依据老师的课后反馈。</p></div>
      : <div className="report-layout">
        <nav className="report-list" aria-label="历次学情报告">{reports.map((item) => <button key={item.id} type="button" className={item.id === shown?.id ? "active" : ""} aria-current={item.id === shown?.id} onClick={() => setSelected(item.id)}>
          <b>{period(item)}</b><small>{new Date(item.createdAt).toLocaleDateString("zh-CN")} 生成</small>
        </button>)}</nav>
        {shown && <ReportView key={shown.id} report={shown} studentName={student.name} onChange={(next) => setReports((items) => items.map((item) => item.id === next.id ? next : item))}
          onRemove={() => void deleteStudentReport(student.id, shown.id).then(() => { setReports((items) => items.filter((item) => item.id !== shown.id)); setSelected(""); }).catch((reason) => setNotice(reason instanceof Error ? reason.message : "删除失败"))} />}
      </div>}
  </section>;
}
