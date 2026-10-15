"use client";

import { homeworkQuestionLabel, isPendingGradingItem } from "../../lib/homework-grading-rules.mjs";
import type { AssignedHomework, HomeworkDay, HomeworkSubmission } from "../../lib/types";

type Result = AssignedHomework["questions"][number]["result"];
const STATE: Record<string, string> = { correct: "对", corrected: "已订正", partial: "部分对", incorrect: "错", pending: "待处理", missing: "未交" };
function resultState(result: Result) {
  if (!result) return "missing";
  if (isPendingGradingItem(result)) return "pending";
  if (result.wasIncorrect) return result.verdict === "correct" ? "corrected" : "incorrect";
  return result.verdict;
}
const plain = (text: string) => text.replace(/\$+/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const day = (time: number) => new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });

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
    `对 ${task.correct}/${task.size}`, task.pending ? `待处理 ${task.pending}` : ""].filter(Boolean).join(" · ");
}

/**
 * An assigned homework as a whole: every question of the sheet, day by day, with its latest result over all uploads
 * (未交 until an upload finds it), actual submission dates, and the next step — upload more, or open the waiting upload.
 */
export function AssignedHomeworkSheet({ submission, busy, onFocus, onContinue, onCorrect }: {
  submission: HomeworkSubmission & { assigned: AssignedHomework }; busy: boolean; onFocus: (assignmentQuestionId: string) => void; onContinue: () => void; onCorrect: (day: number) => void;
}) {
  const { assigned } = submission;
  const counts = assigned.days.reduce((all, day) => ({ correct: all.correct + day.correct, incorrect: all.incorrect + day.incorrect,
    pending: all.pending + day.pending, missing: all.missing - day.done }), { correct: 0, incorrect: 0, pending: 0, missing: assigned.questions.length });
  const handedIn = assigned.questions.length - counts.missing;
  const latest = assigned.uploads.at(-1);
  const days = assigned.days.map((item, index) => {
    const from = assigned.days.slice(0, index).reduce((sum, entry) => sum + entry.size, 0);
    return { ...item, state: dayState(item), items: assigned.questions.slice(from, from + item.size) };
  });
  const first = days[0], several = days.length > 1;
  return <section className="assigned-sheet" aria-label="整份作业">
    <header>
      <div><h2>整份作业</h2><p>{several ? `${days.length} 天任务 · ` : ""}{assigned.questions.length} 道题 · 已交 {handedIn}{handedIn ? ` · 对 ${counts.correct} · 错 ${counts.incorrect}` : ""}{counts.pending ? ` · 待处理 ${counts.pending}` : ""}{counts.missing ? ` · 未交 ${counts.missing}` : ""}</p>
        {!several && first?.handedInAt != null && <p>提交日期：{day(first.handedInAt)}</p>}
      </div>
      {latest && latest.status === "draft" && latest.id !== submission.id ? <a className="primary" href={`/tools/homework/submissions/${encodeURIComponent(latest.id)}`}>去上传</a>
        : latest?.status === "published" ? <button className={counts.missing ? "primary" : ""} disabled={busy} onClick={onContinue} title={counts.missing ? "上传学生后来交的部分" : "学生订正或重做后再批改一次"}>{counts.missing ? "继续上传" : "再上传一次"}</button> : null}
    </header>
    {days.map((group, index) => {
      const note = dayNote(group);
      const mistakes = group.items.filter(({ result }) => result && !isPendingGradingItem(result) && ["incorrect", "partial"].includes(result.verdict)).length;
      const allCorrect = group.done === group.size && group.correct === group.size;
      const correctionLabel = mistakes ? "去订正" : allCorrect ? group.items.some(({ result }) => result?.wasIncorrect) ? "已订正" : "无错题" : "订正";
      const canCorrect = submission.status === "published" && latest?.status === "published";
      return <div className={`assigned-day ${group.state}`} key={index}>
        {several && <div className="assigned-day-head"><b title={group.title}>{group.title}</b><small>{note}</small></div>}
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
        <button type="button" className={`assigned-correct${mistakes ? " incorrect" : allCorrect ? " correct" : ""}`} disabled={busy || !mistakes || !canCorrect} onClick={() => onCorrect(index)} aria-label={`${group.title || "本次作业"}${correctionLabel}`}
          title={allCorrect ? correctionLabel === "已订正" ? "这一天的错题已全部订正正确" : "这一天的题目全部正确，无需订正" : !mistakes ? group.pending ? "请先核实待处理题目" : "提交并批改后可订正错题" : !canCorrect ? "请先完成当前上传和批改" : `上传这一天 ${mistakes} 道错题的订正照片或 PDF`}>{correctionLabel}{allCorrect && <span aria-hidden="true"> ✅</span>}</button>
      </div>;
    })}
    <p className="assigned-correction-note">绿色：原本正确 · 蓝色：已订正正确 · 红色：仍需订正</p>
    {assigned.uploads.length > 1 && <nav className="assigned-uploads" aria-label="上传记录">{assigned.uploads.map((upload) => upload.id === submission.id
      ? <b key={upload.id}>第 {upload.version} 次上传 · {upload.submittedAt == null ? "待上传" : `${day(upload.submittedAt)} 提交`}{upload.pageCount ? ` · ${upload.pageCount} 页` : ""}</b>
      : <a key={upload.id} href={`/tools/homework/submissions/${encodeURIComponent(upload.id)}`}>第 {upload.version} 次上传 · {upload.submittedAt == null ? "待上传" : `${day(upload.submittedAt)} 提交`}{upload.pageCount ? ` · ${upload.pageCount} 页` : ""}</a>)}</nav>}
  </section>;
}
