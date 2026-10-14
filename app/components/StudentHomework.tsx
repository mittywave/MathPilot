"use client";

import { useEffect, useState } from "react";
import { homeworkApi } from "../../lib/homework-api-client";
import type { StudentHomework as Homework, StudentSummary } from "../../lib/types";
import { calendarDay, dayNote, dayState, shortDate, type DayState } from "./AssignedHomeworkSheet";

const busy = (item: Homework) => item.latest.status === "submitted" || item.latest.status === "processing";

// What a homework is waiting for, in a few words. An assigned one goes by its days: a day past its date with nothing
// back comes first, then the day due today; an uploaded one goes by its grading.
function homeworkState(item: Homework, states: DayState[]): { label: string; tone: "waiting" | "busy" | "failed" | "late" | "partial" | "done" } {
  const status = item.latest.status;
  if (busy(item)) return { label: "批改中", tone: "busy" };
  if (status === "failed") return { label: "处理失败", tone: "failed" };
  if (!item.days) return status === "draft" ? { label: "待上传", tone: "waiting" } : { label: "已批改", tone: "done" };
  if (states.every((state) => state === "done")) return { label: "已交齐", tone: "done" };
  const several = item.days.length > 1;
  const late = states.flatMap((state, index) => (state === "late" ? [index + 1] : []));
  if (late.length) return { label: !several ? "没交" : late.length > 1 ? `${late.length} 天没交` : `第 ${late[0]} 天没交`, tone: "late" };
  const due = states.indexOf("today");
  if (due >= 0) return { label: several ? `今天交第 ${due + 1} 天` : "今天交", tone: "waiting" };
  if (!item.done) return { label: `${shortDate(item.days[0].date)} ${several ? "开始" : "要交"}`, tone: "waiting" };
  return { label: several ? `已交 ${states.filter((state) => state === "done" || state === "partial").length}/${item.days.length} 天` : `已交 ${item.done}/${item.total}`, tone: "partial" };
}

const day = (time: number) => new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });

/** 学生档案 · 作业: the student's assigned and uploaded homework, newest first; each row opens its grading page. */
export function StudentHomework({ student }: { student: StudentSummary }) {
  // What was read, and for whom: switching students shows the loading state until that student's list arrives.
  const [loaded, setLoaded] = useState<{ studentId: string; homework: Homework[] | null; error: string } | null>(null);
  useEffect(() => {
    let current = true;
    homeworkApi.studentHomework(student.id).then((result) => { if (current) setLoaded({ studentId: student.id, homework: result.homework, error: "" }); })
      .catch((reason) => { if (current) setLoaded({ studentId: student.id, homework: null, error: reason instanceof Error ? reason.message : "作业记录读取失败" }); });
    return () => { current = false; };
  }, [student.id]);
  const homework = loaded?.studentId === student.id ? loaded.homework : null;
  const error = loaded?.studentId === student.id ? loaded.error : "";

  const today = calendarDay();
  const rows = homework?.map((item) => ({ item, states: item.days?.map((entry) => dayState(entry, today)) ?? [] })) ?? [];
  const waiting = rows.filter(({ item }) => item.assigned && item.done < item.total && !busy(item));
  const late = waiting.filter(({ states }) => states.includes("late")).length;
  return <section className="student-homework" aria-label={`${student.name}的作业`}>
    <header className="student-panel-head">
      <p>{homework ? late ? `${late} 份作业过了日子没交` : waiting.length ? `${waiting.length} 份作业还没交齐` : `共 ${homework.length} 份作业` : "　"}</p>
      <a className="student-panel-action" href={`/tools/homework/upload?studentId=${encodeURIComponent(student.id)}`}>批改一份作业</a>
    </header>
    {error ? <p className="student-panel-empty" role="alert">{error}</p> : !homework ? <div className="wrong-book-loading"><i></i><span>正在读取作业…</span></div>
      : !homework.length ? <div className="student-panel-empty"><b>还没有作业</b><p>在快速排版或智能组卷里点“布置给学生”，题目和答案会存进这里；学生做完后上传学生拍好的照片或 PDF 批改。也可以直接批改一份学校发的作业。</p></div>
      : <ol className="homework-rows">{rows.map(({ item, states }) => {
        const state = homeworkState(item, states); const graded = item.correct + item.incorrect + item.pending;
        const days = item.days ?? [];
        return <li key={item.assignmentId} className={state.tone}>
          <a href={`/tools/homework/submissions/${encodeURIComponent(item.latest.id)}`}>
            <span className="homework-state">{state.label}</span>
            <span className="homework-title"><b>{item.title}</b><small>{days.length > 1 ? `${shortDate(days[0].date)}–${shortDate(days[days.length - 1].date)} · ${days.length} 天 · ${item.total} 道题`
              : days.length ? `交作业日期 ${shortDate(days[0].date)} · ${item.total} 道题` : `${day(item.createdAt)} 上传批改${graded ? ` · ${graded} 道题` : ""}`}</small></span>
            {(days.length > 1 || graded > 0) && <span className="homework-tally">
              {days.length > 1 && <span className="homework-days" aria-label="每天交没交">{days.map((entry, index) => {
                const note = dayNote(entry, states[index]);
                return <i key={index} className={states[index]} title={`第 ${index + 1} 天 · ${shortDate(entry.date)}${note ? ` · ${note}` : ""}`}>{index + 1}</i>;
              })}</span>}
              {graded > 0 && <span className="homework-bar" aria-label={`对 ${item.correct} 道，错 ${item.incorrect} 道，待处理 ${item.pending} 道`}>
                <i className="bar">{(["correct", "incorrect", "pending"] as const).map((key) => item[key] > 0 && <em key={key} className={key} style={{ width: `${item[key] / Math.max(item.total, graded) * 100}%` }} />)}</i>
                <small>对 {item.correct} · 错 {item.incorrect}{item.pending ? ` · 待处理 ${item.pending}` : ""}</small>
              </span>}
            </span>}
            {item.assigned && item.done < item.total && !busy(item) && <span className="homework-go">上传作业</span>}
          </a>
        </li>;
      })}</ol>}
  </section>;
}
