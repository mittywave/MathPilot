"use client";

import { homeworkQuestionLabel } from "../../lib/homework-grading-rules.mjs";
import type { AssignedHomework, HomeworkSubmission } from "../../lib/types";

type Result = AssignedHomework["questions"][number]["result"];
const STATE: Record<string, string> = { correct: "对", partial: "部分对", incorrect: "错", pending: "待处理", missing: "未交" };
function resultState(result: Result) {
  if (!result) return "missing";
  return result.requiresReview || result.verdict === "unreadable" || result.verdict === "review_required" ? "pending" : result.verdict;
}
const plain = (text: string) => text.replace(/\$+/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const day = (time: number) => new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });

/**
 * An assigned homework as a whole: every question of the sheet, day by day, with its latest result over all uploads
 * (未交 until an upload finds it), the uploads so far, and the next step — upload more, or open the waiting upload.
 */
export function AssignedHomeworkSheet({ submission, busy, onFocus, onContinue }: {
  submission: HomeworkSubmission & { assigned: AssignedHomework }; busy: boolean; onFocus: (assignmentQuestionId: string) => void; onContinue: () => void;
}) {
  const { assigned } = submission;
  const counts = assigned.questions.reduce<Record<string, number>>((all, item) => { const state = resultState(item.result); all[state] = (all[state] ?? 0) + 1; return all; }, {});
  const handedIn = assigned.questions.length - (counts.missing ?? 0);
  const latest = assigned.uploads.at(-1);
  const groups = assigned.groups.length ? assigned.groups : [{ title: "", size: assigned.questions.length }];
  const days = groups.map((group, index) => {
    const from = groups.slice(0, index).reduce((sum, item) => sum + item.size, 0);
    return { title: group.title, items: assigned.questions.slice(from, from + group.size) };
  });
  return <section className="assigned-sheet" aria-label="整份作业">
    <header>
      <div><h2>整份作业</h2><p>{assigned.questions.length} 道题 · 已交 {handedIn}{handedIn ? ` · 对 ${counts.correct ?? 0} · 错 ${(counts.incorrect ?? 0) + (counts.partial ?? 0)}` : ""}{counts.pending ? ` · 待处理 ${counts.pending}` : ""}{counts.missing ? ` · 未交 ${counts.missing}` : ""}</p></div>
      {latest && latest.status === "draft" && latest.id !== submission.id ? <a className="primary" href={`/tools/homework/submissions/${encodeURIComponent(latest.id)}`}>去上传</a>
        : latest?.status === "published" ? <button className={counts.missing ? "primary" : ""} disabled={busy} onClick={onContinue} title={counts.missing ? "上传学生后来交的部分" : "学生订正或重做后再批改一次"}>{counts.missing ? "继续上传" : "再上传一次"}</button> : null}
    </header>
    {days.map((group, index) => <div className="assigned-day" key={index}>
      {group.title && <b>{group.title}</b>}
      <ol>{group.items.map((item) => {
        const state = resultState(item.result); const here = item.result?.submissionId === submission.id;
        const label = `${homeworkQuestionLabel(item.number)} · ${STATE[state]}`;
        const number = item.number.replace(/^D\d+-/, "");
        return <li key={item.id} className={state} title={`${label}\n${plain(item.question.stem ?? "")}`}>
          {here ? <button type="button" aria-label={label} onClick={() => onFocus(item.id)}>{number}</button>
            : item.result ? <a aria-label={`${label}（在第 ${assigned.uploads.find((upload) => upload.id === item.result!.submissionId)?.version ?? "?"} 次上传里）`} href={`/tools/homework/submissions/${encodeURIComponent(item.result.submissionId)}`}>{number}</a>
            : <span aria-label={label}>{number}</span>}
        </li>;
      })}</ol>
    </div>)}
    {assigned.uploads.length > 1 && <nav className="assigned-uploads" aria-label="上传记录">{assigned.uploads.map((upload) => upload.id === submission.id
      ? <b key={upload.id}>第 {upload.version} 次上传 · {day(upload.submittedAt ?? upload.createdAt)}{upload.pageCount ? ` · ${upload.pageCount} 页` : ""}</b>
      : <a key={upload.id} href={`/tools/homework/submissions/${encodeURIComponent(upload.id)}`}>第 {upload.version} 次上传 · {day(upload.submittedAt ?? upload.createdAt)}{upload.pageCount ? ` · ${upload.pageCount} 页` : upload.status === "draft" ? " · 待上传" : ""}</a>)}</nav>}
  </section>;
}
