"use client";

import { useEffect, useState } from "react";
import { homeworkApi } from "../../lib/homework-api-client";
import type { StudentHomework as Homework, StudentSummary } from "../../lib/types";

// What a homework is waiting for, in one word: assigned ones by how much of the sheet came back, uploaded ones by grading.
function homeworkState(item: Homework): { label: string; tone: "waiting" | "busy" | "failed" | "partial" | "done" } {
  const status = item.latest.status;
  if (status === "submitted" || status === "processing") return { label: "批改中", tone: "busy" };
  if (status === "failed") return { label: "处理失败", tone: "failed" };
  if (!item.assigned) return status === "draft" ? { label: "待上传", tone: "waiting" } : { label: "已批改", tone: "done" };
  if (!item.done) return { label: "待提交", tone: "waiting" };
  return item.done < item.total ? { label: `已交 ${item.done}/${item.total}`, tone: "partial" } : { label: "已交齐", tone: "done" };
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

  const waiting = homework?.filter((item) => item.assigned && item.done < item.total && !["submitted", "processing"].includes(item.latest.status)).length ?? 0;
  return <section className="student-homework" aria-label={`${student.name}的作业`}>
    <header className="student-panel-head">
      <p>{homework ? waiting ? `${waiting} 份作业还没交齐` : `共 ${homework.length} 份作业` : "　"}</p>
      <a className="student-panel-action" href={`/tools/homework/upload?studentId=${encodeURIComponent(student.id)}`}>批改一份作业</a>
    </header>
    {error ? <p className="student-panel-empty" role="alert">{error}</p> : !homework ? <div className="wrong-book-loading"><i></i><span>正在读取作业…</span></div>
      : !homework.length ? <div className="student-panel-empty"><b>还没有作业</b><p>在快速排版或智能组卷里点“布置给学生”，题目和答案会存进这里；学生做完后上传学生拍好的照片或 PDF 批改。也可以直接批改一份学校发的作业。</p></div>
      : <ol className="homework-rows">{homework.map((item) => {
        const state = homeworkState(item); const graded = item.correct + item.incorrect + item.pending;
        return <li key={item.assignmentId} className={state.tone}>
          <a href={`/tools/homework/submissions/${encodeURIComponent(item.latest.id)}`}>
            <span className="homework-state">{state.label}</span>
            <span className="homework-title"><b>{item.title}</b><small>{item.assigned ? `${day(item.createdAt)} 布置 · ${item.total} 道题` : `${day(item.createdAt)} 上传批改${graded ? ` · ${graded} 道题` : ""}`}</small></span>
            {graded > 0 && <span className="homework-tally" aria-label={`对 ${item.correct} 道，错 ${item.incorrect} 道，待处理 ${item.pending} 道`}>
              <i className="bar">{(["correct", "incorrect", "pending"] as const).map((key) => item[key] > 0 && <em key={key} className={key} style={{ width: `${item[key] / Math.max(item.total, graded) * 100}%` }} />)}</i>
              <small>对 {item.correct} · 错 {item.incorrect}{item.pending ? ` · 待处理 ${item.pending}` : ""}</small>
            </span>}
            {item.assigned && item.done < item.total && !["submitted", "processing"].includes(item.latest.status) && <span className="homework-go">上传作业</span>}
          </a>
        </li>;
      })}</ol>}
  </section>;
}
