"use client";

import { useState, type ReactNode } from "react";
import { homeworkQuestionLabel, isPendingGradingItem } from "../../lib/homework-grading-rules.mjs";
import type { AssignedHomework, GradingItem, HomeworkDay, HomeworkSubmission, Question, SubmissionStatus } from "../../lib/types";
import { DocxContent } from "./DocxContent";
import { MathText } from "./MathText";
import { QuestionBody } from "./QuestionBody";
import { StudioSolution } from "./StudioSolution";

type Result = GradingItem | AssignedHomework["questions"][number]["result"];
type Bucket = "correct" | "corrected" | "partial" | "incorrect" | "pending" | "missing";
const STATE: Record<string, string> = { correct: "对", corrected: "已订正", incorrect: "错", pending: "待处理", missing: "未交" };
/** School questions are either wholly correct or still need correction; exam papers retain step marks. */
export function resultState(result: Result, international = false): Bucket {
  if (!result) return "missing";
  if (isPendingGradingItem(result)) return "pending";
  if (international) return result.verdict as Bucket;
  if (result.verdict !== "correct") return "incorrect";
  return "wasIncorrect" in result && result.wasIncorrect ? "corrected" : "correct";
}

/** The same question states drive both the numbered squares and the distribution. */
export function VerdictTally({ items, total, international = false }: { items: Result[]; total: number; international?: boolean }) {
  const buckets: Array<[Bucket, string]> = international
    ? [["correct", "正确"], ["partial", "部分正确"], ["incorrect", "错误"], ["pending", "待处理"]]
    : [["correct", "正确"], ["incorrect", "错误（待订正）"], ["corrected", "已订正"]];
  const counts: Record<Bucket, number> = { correct: 0, corrected: 0, partial: 0, incorrect: 0, pending: 0, missing: 0 };
  for (const item of items) counts[resultState(item, international)]++;
  if (!international && counts.missing > 0) buckets.push(["missing", "未交"]);
  const confirmed = counts.correct + counts.incorrect + counts.corrected;
  const scale = Math.max(total, items.length, 1);
  return <div className={`verdict-tally${international ? "" : " school"}`}>
    <div className="tally-bar" role="img" aria-label={international ? `${total} 道题中已批改 ${items.length} 道` : `${total} 道题中已确认 ${confirmed} 道：正确 ${counts.correct}，错误（待订正）${counts.incorrect}，已订正 ${counts.corrected}，未交 ${counts.missing}${counts.pending ? `，待核实 ${counts.pending}` : ""}`}>{buckets.map(([key]) => counts[key] > 0 && <i key={key} className={key} style={{ width: `${counts[key] / scale * 100}%` }} />)}</div>
    <dl>{buckets.map(([key, label]) => <div key={key} className={key}><dt>{label}</dt><dd>{counts[key]}</dd></div>)}</dl>
    {!international && counts.pending > 0 && <small>待核实 {counts.pending} 道</small>}
  </div>;
}
const plain = (text: string) => text.replace(/\$+/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const day = (time: number) => new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }).replaceAll("/", ".");

export type DayState = "done" | "partial" | "missing";
/** Each day is a task group; its progress depends only on what has been handed in. */
export function dayState(day: HomeworkDay): DayState {
  if (day.done >= day.size) return "done";
  if (day.done > 0) return "partial";
  return "missing";
}
/** Only actual submission dates are shown; an unsubmitted task has no date. */
export function dayNote(task: HomeworkDay) {
  if (!task.done) return "未提交";
  return [task.handedInAt == null ? "" : `${day(task.handedInAt)} 提交`, task.done < task.size ? `已交 ${task.done}/${task.size}` : "",
    `首交对 ${task.firstAttempt.correct}/${task.size}`, task.pending ? `待处理 ${task.pending}` : ""].filter(Boolean).join(" · ");
}

type LatestUpload = { version: number; status: SubmissionStatus } | undefined;
const GRADING: SubmissionStatus[] = ["submitted", "processing", "ready", "review_required"];
/** One upload of a homework is graded at a time: why a new upload has to wait, or "" when it can start now. */
export function uploadWait(latest: LatestUpload) {
  return latest && GRADING.includes(latest.status) ? `第 ${latest.version} 次上传还在批改，完成或停止批改后再上传` : "";
}
/** A new upload takes the place of a failed latest upload, so the teacher is asked first. */
export function confirmGivingUp(latest: LatestUpload, next: string) {
  return latest?.status !== "failed" || window.confirm(`第 ${latest.version} 次上传处理失败。放弃这次上传，改为${next}？`);
}
export const uploadNote = (upload: AssignedHomework["uploads"][number]) => [upload.submittedAt == null ? "待上传" : `${day(upload.submittedAt)} 提交`,
  upload.status === "failed" ? "处理失败" : GRADING.includes(upload.status) ? "批改中" : "", upload.pageCount ? `${upload.pageCount} 页` : ""].filter(Boolean).join(" · ");

/**
 * An assigned homework as a whole: every question of the sheet, day by day, with its latest result over all uploads
 * (未交 until an upload finds it), actual submission dates, and the next step — upload more, or open the waiting upload.
 */
export function AssignedHomeworkSheet({ submission, busy, selectedDay, onDay, onFocus, onContinue, onCorrect, onUpload, onExport, children }: {
  submission: HomeworkSubmission & { assigned: AssignedHomework }; busy: boolean; onFocus: (assignmentQuestionId: string) => void; onContinue: () => void; onCorrect: (day: number) => void; onUpload: (day: number) => void;
  selectedDay: number | null; onDay: (day: number) => void; onExport: (questions: Question[], kind: "word" | "pdf", includeAnalysis?: boolean) => void;
  children?: ReactNode;
}) {
  const { assigned } = submission;
  const [showOriginals, setShowOriginals] = useState(false);
  const [expandedAnalyses, setExpandedAnalyses] = useState<string[]>([]);
  const mistakes = assigned.questions.filter(({ result }) => result && !isPendingGradingItem(result) && ["incorrect", "partial"].includes(result.verdict));
  const latest = assigned.uploads.at(-1), wait = uploadWait(latest);
  const days = assigned.days.map((item, index) => {
    const from = assigned.days.slice(0, index).reduce((sum, entry) => sum + entry.size, 0);
    return { ...item, state: dayState(item), items: assigned.questions.slice(from, from + item.size) };
  });
  const several = days.length > 1;
  const nextUpload = latest && latest.status !== "published" && latest.id !== submission.id && (latest.status !== "draft" || several || !mistakes.length) ? <a className="primary" href={`/tools/homework/submissions/${encodeURIComponent(latest.id)}`}>{latest.status === "draft" ? "去上传" : latest.status === "failed" ? "去处理" : "查看批改进度"}</a>
    : latest?.status === "published" && days.some((group) => group.state !== "done") && (several || !mistakes.length) ? <button className="primary" disabled={busy} onClick={onContinue} title="上传学生后来交的部分">继续上传</button> : null;
  const corrections = days.map((group, index) => {
    const mistakes = group.items.filter(({ result }) => result && !isPendingGradingItem(result) && ["incorrect", "partial"].includes(result.verdict)).length;
    const allCorrect = group.done === group.size && group.correct === group.size;
    const correctionLabel = mistakes ? "去订正" : allCorrect ? group.items.some(({ result }) => result?.wasIncorrect) ? "已订正" : "无错题" : "订正";
    return (mistakes > 0 || group.state === "done") && <button key={index} type="button" className={`assigned-correct${mistakes ? " incorrect" : allCorrect ? " correct" : ""}`} disabled={busy || !mistakes || Boolean(wait)} onClick={() => onCorrect(index)} aria-label={`${group.title || "本次作业"}${correctionLabel}`}
      title={allCorrect ? correctionLabel === "已订正" ? "这一天的错题已全部订正正确" : "这一天的题目全部正确，无需订正" : !mistakes ? "请先核实待处理题目" : wait || `上传这一天 ${mistakes} 道错题的订正照片或 PDF`}>{correctionLabel}{allCorrect && <span aria-hidden="true"> ✅</span>}</button>;
  });
  return <>
    <section className="review-summary">
      {children}
      <div className="assigned-sheet-actions">
        <button type="button" aria-expanded={showOriginals} aria-controls="assigned-originals" onClick={() => setShowOriginals((shown) => !shown)}>{showOriginals ? "收起原题" : "查看原题"}</button>
        {[false, true].map((includeAnalysis) => {
          const label = includeAnalysis ? "导出解析" : "导出错题";
          const questions = (includeAnalysis ? assigned.questions : mistakes).map((item) => item.question);
          const available = includeAnalysis ? questions.some((question) => question.answer?.trim() || question.analysis?.trim() || question.analysisDocxXml?.length || question.studioSource?.diagrams.length) : questions.length > 0;
          const title = includeAnalysis ? available ? `导出整份作业 ${questions.length} 道题的原题、答案与解析` : "当前作业暂无答案或解析"
            : available ? `导出当前仍需订正的 ${questions.length} 道题，不含答案` : "当前没有需要订正的错题";
          return <select key={label} className="secondary" aria-label={label} defaultValue="" disabled={busy || !available} title={title}
            onChange={(event) => {
              const kind = event.currentTarget.value;
              event.currentTarget.value = "";
              if (kind === "pdf" || kind === "word") onExport(questions, kind, includeAnalysis);
            }}>
            <option value="" disabled>{label}</option><option value="pdf">PDF</option><option value="word">Word</option>
          </select>;
        })}
      </div>
    </section>
    <section className="assigned-sheet" aria-label="整份作业">
    {several && nextUpload && <header><div className="assigned-sheet-actions">{nextUpload}</div></header>}
    {days.map((group, index) => {
      const note = dayNote(group);
      const dayName = several ? `第 ${index + 1} 天` : "这份作业";
      return <div className={`assigned-day ${group.state}`} key={index}>
        {several && <div className="assigned-day-head"><button type="button" onClick={() => onDay(index)} aria-pressed={selectedDay === index}
          aria-controls="day-results" title={`查看${group.title || dayName}的提交与批改情况`}>{group.title || dayName}</button><small>{note}</small></div>}
        <ol>{group.items.map((item) => {
          const state = resultState(item.result); const here = item.result?.submissionId === submission.id;
          const label = `${homeworkQuestionLabel(item.number)} · ${STATE[state]}`;
          const number = item.number.replace(/^D\d+-/, "");
          return <li key={item.id} className={state} title={`${label}\n${plain(item.question.stem ?? "")}`}>
            {here || (selectedDay === index && item.result) ? <button type="button" aria-label={label} onClick={() => onFocus(item.id)}>{number}</button>
              : item.result ? <a aria-label={`${label}（在第 ${assigned.uploads.find((upload) => upload.id === item.result!.submissionId)?.version ?? "?"} 次上传里）`} href={`/tools/homework/submissions/${encodeURIComponent(item.result.submissionId)}`}>{number}</a>
              : <span aria-label={label}>{number}</span>}
          </li>;
        })}</ol>
        {/* A day not handed in yet is uploaded on its own; corrections only make sense for what has been handed in. */}
        {several && group.state !== "done" && <button type="button" className="assigned-upload" disabled={busy || Boolean(wait)} onClick={() => onUpload(index)} aria-label={`${group.title || dayName}上传这天`}
          title={wait || `上传${dayName}还没交的 ${group.size - group.done} 道题的照片或 PDF，只批改这几道`}>上传这天</button>}
        {several ? corrections[index] : <div className="assigned-sheet-actions">{nextUpload}{corrections[index]}</div>}
      </div>;
    })}
    {assigned.uploads.length > 1 && <nav className="assigned-uploads" aria-label="上传记录">{assigned.uploads.map((upload) => upload.id === submission.id
      ? <b key={upload.id}>第 {upload.version} 次上传 · {uploadNote(upload)}</b>
      : <a key={upload.id} href={`/tools/homework/submissions/${encodeURIComponent(upload.id)}`}>第 {upload.version} 次上传 · {uploadNote(upload)}</a>)}</nav>}
    {showOriginals && <section className="assigned-originals" id="assigned-originals" aria-label="作业原题">
      <h3>作业原题</h3>
      {days.map((group, index) => <div key={index}>
        {several && <h4>{group.title || `第 ${index + 1} 天`}</h4>}
        <div className="question-list">{group.items.map((item) => {
          const question = item.question;
          const hasAnalysis = Boolean(question.analysis.trim() || question.analysisDocxXml?.length || question.studioSource?.diagrams.length);
          const analysisOpen = hasAnalysis && expandedAnalyses.includes(item.id);
          return <article className="question-card" key={item.id} aria-label={homeworkQuestionLabel(item.number)}>
            <div className="question-main">
              <QuestionBody question={question} number={item.number.replace(/^D\d+-/, "")} />
              {analysisOpen && <div className="answer-box" id={`assigned-analysis-${item.id}`}>
                {question.answer.trim() && <><b>答案</b><p><MathText text={question.answer} /></p></>}
                <b>解析</b><div className="analysis-content">{question.studioSource ? <StudioSolution source={{ ...question.studioSource, analysis: question.analysis }} /> : <DocxContent xml={question.analysisDocxXml} fallback={question.analysis} />}</div>
              </div>}
              {hasAnalysis && <div className="question-actions"><button type="button" aria-expanded={analysisOpen} aria-controls={`assigned-analysis-${item.id}`}
                onClick={() => setExpandedAnalyses((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}>{analysisOpen ? "收起解析" : "查看解析"}</button></div>}
            </div>
          </article>;
        })}</div>
      </div>)}
    </section>}
  </section></>;
}
