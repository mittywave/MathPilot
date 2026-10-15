"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchLibrary, fetchTypesetRecords } from "../../lib/api-client";
import { homeworkApi } from "../../lib/homework-api-client";
import { titleWithoutStudent } from "../../lib/homework-grading-rules.mjs";
import { planDays } from "../../lib/smart-paper-contract";
import type { StudentHomework as Homework, HomeworkSheetGroup, Question, StudentSummary, TypesetRecord } from "../../lib/types";
import { AssignHomework } from "./AssignHomework";
import { dayNote, dayState, type DayState } from "./AssignedHomeworkSheet";

const busy = (item: Homework) => item.latest.status === "submitted" || item.latest.status === "processing";
export const homeworkInProgress = (item: Homework) => item.latest.status !== "published" || item.pending > 0 || (item.assigned && item.done < item.total);

// An assigned homework goes by task completion; an uploaded one goes by its grading.
function homeworkState(item: Homework, states: DayState[]): { label: string; tone: "waiting" | "busy" | "failed" | "partial" | "done" } {
  const status = item.latest.status;
  if (busy(item)) return { label: "批改中", tone: "busy" };
  if (status === "failed") return { label: "处理失败", tone: "failed" };
  if (!item.days) return status === "draft" ? { label: "待上传", tone: "waiting" } : { label: "已批改", tone: "done" };
  if (states.every((state) => state === "done")) return { label: "已交齐", tone: "done" };
  const several = item.days.length > 1;
  if (!item.done) return { label: "未提交", tone: "waiting" };
  return { label: several ? `已交 ${states.filter((state) => state === "done").length}/${item.days.length} 天` : `已交 ${item.done}/${item.total}`, tone: "partial" };
}

const day = (time: number) => new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });

/**
 * 布置作业 in the archive: the plans 智能组卷 made for this student that are not handed out yet. Picking one takes its
 * questions from the library day by day and opens the same 布置给学生 dialog as 快速排版, with the student chosen.
 */
function AssignPlan({ student, handedOut, onClose, onAssigned }: { student: StudentSummary; handedOut: string[]; onClose: () => void; onAssigned: () => void }) {
  const [plans, setPlans] = useState<TypesetRecord[] | null>(null);
  const [opening, setOpening] = useState("");
  const [error, setError] = useState("");
  const [material, setMaterial] = useState<{ record: TypesetRecord; questions: Question[]; groups: HomeworkSheetGroup[] } | null>(null);
  useEffect(() => {
    let current = true;
    fetchTypesetRecords().then(({ records }) => { if (current) setPlans(records.filter((record) => record.plan && record.studentId === student.id && !handedOut.includes(record.id))); })
      .catch((reason) => { if (current) { setPlans([]); setError(reason instanceof Error ? reason.message : "组卷记录读取失败"); } });
    return () => { current = false; };
  }, [student.id, handedOut]);

  async function open(record: TypesetRecord) {
    if (!record.plan) return;
    setOpening(record.id); setError("");
    try {
      const days = planDays(record.plan, new Map((await fetchLibrary()).questions.map((question) => [question.id, question])));
      if (!days.length) throw new Error("这份卷里的题都已不在题库中");
      setMaterial({ record, questions: days.flatMap((entry) => entry.questions), groups: days.map((entry) => ({ title: entry.title, size: entry.questions.length })) });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "取题失败"); }
    finally { setOpening(""); }
  }

  if (material) return <AssignHomework title={material.record.title} questions={material.questions} groups={material.groups} studentId={student.id}
    recordId={material.record.id} origin="智能组卷" onClose={onClose} onAssigned={onAssigned} />;
  return <div className="modal-backdrop">
    <section className="modal assign-modal" role="dialog" aria-modal="true" aria-label={`给${student.name}布置作业`} aria-busy={Boolean(opening)}>
      <div className="modal-head"><div><span className="eyebrow">学生档案</span><h2>给{student.name}布置作业</h2></div><button className="close" aria-label="关闭" disabled={Boolean(opening)} onClick={onClose}>×</button></div>
      {plans === null ? <p className="assign-hint">正在读取给{student.name}组的卷…</p>
        : plans.length ? <ul className="assign-plans" aria-label="组好还没布置的卷">{plans.map((plan) => <li key={plan.id}>
          <button type="button" disabled={Boolean(opening)} onClick={() => void open(plan)}>
            <b>{plan.title}</b><small>{day(plan.createdAt)} 智能组卷 · {plan.plan!.groups.length > 1 ? `${plan.plan!.groups.length} 天 · ` : ""}{plan.questionCount} 道题</small>
            <span>{opening === plan.id ? "正在取题…" : "布置"}</span>
          </button>
        </li>)}</ul>
        : <p className="assign-empty">没有给{student.name}组好、还没布置的卷。</p>}
      <p className="assign-hint">要新组一份，点 <a href={`/tools/smart-paper?student=${encodeURIComponent(student.id)}`}>智能组卷</a>，排好后点“布置给学生”。Word 练习在快速排版里打开后点“布置给学生”。</p>
      {error && <p className="assign-error" role="alert">{error}</p>}
    </section>
  </div>;
}

/** 学生档案 · 作业: the student's assigned and uploaded homework, newest first; each row opens its grading page. */
export function StudentHomework({ student, onProgressChange }: { student: StudentSummary; onProgressChange?: (studentId: string, inProgress: boolean) => void }) {
  // What was read, and for whom: switching students shows the loading state until that student's list arrives.
  const [loaded, setLoaded] = useState<{ studentId: string; homework: Homework[] | null; error: string } | null>(null);
  // Read again after a homework is assigned here.
  const [reads, setReads] = useState(0);
  const [assigning, setAssigning] = useState(false);
  useEffect(() => {
    let current = true;
    homeworkApi.studentHomework(student.id).then((result) => { if (current) { setLoaded({ studentId: student.id, homework: result.homework, error: "" }); onProgressChange?.(student.id, result.homework.some(homeworkInProgress)); } })
      .catch((reason) => { if (current) setLoaded({ studentId: student.id, homework: null, error: reason instanceof Error ? reason.message : "作业记录读取失败" }); });
    return () => { current = false; };
  }, [student.id, reads, onProgressChange]);
  const homework = loaded?.studentId === student.id ? loaded.homework : null;
  const error = loaded?.studentId === student.id ? loaded.error : "";
  const closeAssign = useCallback(() => setAssigning(false), []);
  const assigned = useCallback(() => { setAssigning(false); setReads((count) => count + 1); }, []);
  const [handedOut, setHandedOut] = useState<string[]>([]);

  const rows = homework?.map((item) => ({ item, states: item.days?.map(dayState) ?? [] })) ?? [];
  const waiting = rows.filter(({ item }) => item.assigned && item.done < item.total && !busy(item));
  return <section className="student-homework" aria-label={`${student.name}的作业`}>
    <header className="student-panel-head">
      <p>{homework ? waiting.length ? `${waiting.length} 份作业还没交齐` : `共 ${homework.length} 份作业` : "　"}</p>
      <div className="student-panel-actions">
        <button type="button" className="student-panel-action" disabled={!homework} onClick={() => { setHandedOut(homework?.flatMap((item) => item.recordId ?? []) ?? []); setAssigning(true); }}>布置作业</button>
        <a className="primary-button" href={`/tools/homework/upload?studentId=${encodeURIComponent(student.id)}`}>批改一份作业</a>
      </div>
    </header>
    {assigning && <AssignPlan student={student} handedOut={handedOut} onClose={closeAssign} onAssigned={assigned} />}
    {error ? <p className="student-panel-empty" role="alert">{error}</p> : !homework ? <div className="wrong-book-loading"><i></i><span>正在读取作业…</span></div>
      : !homework.length ? <div className="student-panel-empty"><b>还没有作业</b><p>点“布置作业”把给这位学生组好的卷布置下去，Word 练习在快速排版里点“布置给学生”；题目和答案会存进这里，学生做完后上传学生拍好的照片或 PDF 批改。也可以直接批改一份学校发的作业。</p></div>
      : <ol className="homework-rows">{rows.map(({ item, states }) => {
        const state = homeworkState(item, states); const graded = item.correct + item.incorrect + item.pending;
        const days = item.days ?? [];
        return <li key={item.assignmentId} className={state.tone}>
          <a href={`/tools/homework/submissions/${encodeURIComponent(item.latest.id)}`}>
            <span className="homework-state">{state.label}</span>
            <span className="homework-title"><b>{titleWithoutStudent(item.title, student.name)}</b><small>{days.length > 1 ? `${days.length} 天任务 · ${item.total} 道题`
              : days.length ? `${item.total} 道题${days[0].handedInAt == null ? "" : ` · ${day(days[0].handedInAt)} 提交`}` : `${day(item.createdAt)} 上传批改${graded ? ` · ${graded} 道题` : ""}`}</small></span>
            {(days.length > 1 || graded > 0) && <span className="homework-tally">
              {days.length > 1 && <span className="homework-days" aria-label="各天任务进度">{days.map((entry, index) => {
                const note = dayNote(entry);
                return <i key={index} className={states[index]} title={`第 ${index + 1} 天 · ${note}`}>{index + 1}</i>;
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
