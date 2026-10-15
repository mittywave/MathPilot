"use client";
import { useEffect, useState } from "react";
import { homeworkApi } from "../../lib/homework-api-client";
import type { HomeworkSheetGroup, Question, StudentSummary } from "../../lib/types";

type Assigned = Array<{ id: string; studentId: string; studentName: string }>;

// 布置给学生: a material becomes a homework of each chosen student, its questions and answers stored now — the one open
// in 快速排版, or a plan picked in the student's archive. What the student hands in is uploaded later from the
// student's archive, in one go or task by task, without preset dates. The 快速排版 record it came from is remembered,
// so the archive knows it is out.
export function AssignHomework({ title, questions, groups, studentId, recordId, origin = "快速排版", onClose, onAssigned }: {
  title: string; questions: Question[]; groups?: HomeworkSheetGroup[]; studentId?: string | null; recordId?: string | null; origin?: string;
  onClose: () => void;
  /** Called instead of showing the confirmation, when the caller shows the new homework itself. */
  onAssigned?: () => void;
}) {
  const [students, setStudents] = useState<StudentSummary[] | null>(null);
  const [chosen, setChosen] = useState<string[]>(studentId ? [studentId] : []);
  const [name, setName] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [assigned, setAssigned] = useState<Assigned | null>(null);

  useEffect(() => {
    void homeworkApi.students().then((result) => setStudents(result.students)).catch((reason) => setError(reason instanceof Error ? reason.message : "学生档案读取失败"));
  }, []);

  const answered = questions.filter((question) => question.answer.trim() && question.answer !== "见解析" || question.analysis.trim()).length;
  const days = groups?.length ?? 0;
  const toggle = (id: string) => setChosen((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  async function assign() {
    if (!chosen.length || !name.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const result = await homeworkApi.assign({ studentIds: chosen, title: name.trim(), questions, groups, recordId });
      if (onAssigned) onAssigned(); else setAssigned(result.assigned);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "布置失败"); }
    finally { setBusy(false); }
  }

  return <div className="modal-backdrop">
    <section className="modal assign-modal" role="dialog" aria-modal="true" aria-label="布置给学生" aria-busy={busy}>
      <div className="modal-head"><div><span className="eyebrow">{origin}</span><h2>布置给学生</h2></div><button className="close" aria-label="关闭" disabled={busy} onClick={onClose}>×</button></div>
      {assigned ? <>
        <p className="assign-done">已布置给 {assigned.map((item) => item.studentName).join("、")}。学生做完后，在学生档案的“作业”里上传学生拍好的照片或 PDF。</p>
        <div className="assign-links">{assigned.map((item) => <a key={item.id} href={`/?view=wrong-book&studentId=${encodeURIComponent(item.studentId)}&tab=homework`}>打开{item.studentName}的档案</a>)}</div>
        <div className="modal-actions"><button className="primary-button" onClick={onClose}>完成</button></div>
      </> : <>
        <label className="field">作业名称<input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
        <fieldset className="assign-students" disabled={busy}>
          <legend>布置给</legend>
          {students === null ? <p>正在读取学生档案…</p> : students.length ? students.map((student) => <label key={student.id} className={chosen.includes(student.id) ? "on" : ""}>
            <input type="checkbox" checked={chosen.includes(student.id)} onChange={() => toggle(student.id)} />
            <b>{student.name}</b>{student.className && <small>{student.className}</small>}
          </label>) : <p>还没有学生档案，请先在“学生档案”里新建学生。</p>}
        </fieldset>
        <p className="assign-summary">{questions.length} 道题{days > 1 ? ` · ${days} 天任务` : ""} · {answered === questions.length ? "全部带答案" : `${answered} 道带答案，其余 ${questions.length - answered} 道批改时由 AI 解题`}</p>
        <p className="assign-hint">题目和答案现在就存进作业。学生做完后，在学生档案的“作业”里上传学生拍好的照片或 PDF，按这份清单批改，可以分几次上传；没交的题不算错。{days > 1 ? "各天任务可以分开完成，只记录实际提交日期。" : "只记录实际提交日期。"}</p>
        {error && <p className="assign-error" role="alert">{error}</p>}
        <div className="modal-actions"><button className="secondary" disabled={busy} onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy || !chosen.length || !name.trim()} onClick={() => void assign()}>{busy ? "正在布置…" : chosen.length > 1 ? `布置给 ${chosen.length} 位学生` : "布置"}</button></div>
      </>}
    </section>
  </div>;
}
