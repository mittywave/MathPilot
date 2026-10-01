"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- vinext beta currently breaks next/link RSC prefetch on these client-only pages. */

import { useEffect, useMemo, useRef, useState } from "react";
import { MathText } from "../../components/MathText";
import { studentHomeworkApi, uploadHomeworkAsset } from "../../../lib/homework-api-client";
import { randomClientId } from "../../../lib/client-random-id.mjs";
import type { Assignment, HomeworkSubmission, StudentAuth } from "../../../lib/types";

const STATUS: Record<string, string> = {
  draft: "待提交", submitted: "已提交", processing: "自动批改中", review_required: "老师处理中",
  ready: "等待发布", published: "结果已完成", returned: "请重新提交", failed: "处理失败",
};
const VERDICT: Record<string, string> = { correct: "正确", partial: "部分正确", incorrect: "错误", unreadable: "无法辨认", review_required: "处理中" };
type SelectedPhoto = { id: string; file: File; url: string };

export default function StudentPortalPage() {
  const [teacherCode, setTeacherCode] = useState("");
  const [student, setStudent] = useState<StudentAuth | null>(null);
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [submissions, setSubmissions] = useState<HomeworkSubmission[]>([]);
  const [activeSubmission, setActiveSubmission] = useState<HomeworkSubmission | null>(null);
  const [resultSubmission, setResultSubmission] = useState<HomeworkSubmission | null>(null);
  const [photos, setPhotos] = useState<SelectedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const latestByAssignment = useMemo(() => {
    const latest = new Map<string, HomeworkSubmission>();
    for (const submission of submissions) {
      if (!latest.has(submission.assignmentId) || submission.version > latest.get(submission.assignmentId)!.version) latest.set(submission.assignmentId, submission);
    }
    return latest;
  }, [submissions]);
  const hasProcessing = submissions.some((submission) => ["submitted", "processing"].includes(submission.status));

  async function loadPortal() {
    const [assignmentData, submissionData] = await Promise.all([studentHomeworkApi.assignments(), studentHomeworkApi.submissions()]);
    setAssignments(assignmentData.assignments);
    setSubmissions(submissionData.submissions);
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const code = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] ?? "");
      setTeacherCode(code);
      void studentHomeworkApi.me().then(async (result) => {
        setStudent(result.student);
        if (result.student) await loadPortal();
      }).catch(() => undefined).finally(() => setChecking(false));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!student || !hasProcessing) return;
    const timer = window.setInterval(() => { void loadPortal(); }, 6_000);
    return () => window.clearInterval(timer);
  }, [student, hasProcessing]);

  async function login() {
    setBusy(true);
    setMessage("");
    try {
      const result = await studentHomeworkApi.login(teacherCode, loginId, password);
      setStudent(result.student);
      setPassword("");
      await loadPortal();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败");
    } finally { setBusy(false); }
  }

  function releasePhotos() {
    for (const photo of photos) URL.revokeObjectURL(photo.url);
    setPhotos([]);
  }

  async function logout() {
    releasePhotos();
    await studentHomeworkApi.logout();
    setStudent(null);
    setAssignments([]);
    setSubmissions([]);
    setResultSubmission(null);
  }

  async function openAssignment(assignment: Assignment, existing?: HomeworkSubmission) {
    setBusy(true);
    setMessage("");
    try {
      if (existing?.status === "published") {
        const result = await studentHomeworkApi.submission(existing.id);
        setResultSubmission(result.submission);
        return;
      }
      const result = await studentHomeworkApi.createSubmission(assignment.id);
      if (result.submission.status === "failed") {
        const retried = await studentHomeworkApi.updateSubmission(result.submission.id, { action: "retry" });
        setMessage(`已重新提交自动批改任务，当前状态：${STATUS[retried.submission.status]}`);
        await loadPortal();
        return;
      }
      releasePhotos();
      setActiveSubmission(result.submission);
      if (!["draft", "returned"].includes(result.submission.status)) setMessage(`这份作业当前状态：${STATUS[result.submission.status]}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法打开作业");
    } finally { setBusy(false); }
  }

  function addPhotos(files: FileList | null) {
    const selected = [...(files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!selected.length) { setMessage("请选择图片格式的作业照片"); return; }
    const remaining = Math.max(0, 100 - photos.length);
    const next = selected.slice(0, remaining).map((file) => ({ id: randomClientId(), file, url: URL.createObjectURL(file) }));
    setPhotos((current) => [...current, ...next]);
    if (selected.length > remaining) setMessage("每次提交最多选择 100 张照片");
  }

  function removePhoto(id: string) {
    const photo = photos.find((item) => item.id === id);
    if (photo) URL.revokeObjectURL(photo.url);
    setPhotos((current) => current.filter((item) => item.id !== id));
  }

  async function submitPhotos() {
    if (!activeSubmission || !photos.length) return;
    setBusy(true);
    setMessage("正在私密上传作业照片…");
    try {
      const saved = [];
      for (const [index, photo] of photos.entries()) {
        const original = await uploadHomeworkAsset({ blob: photo.file, fileName: `答卷原件-${index + 1}-${photo.file.name}`, role: "submission_original", pageOrder: index, submissionId: activeSubmission.id });
        const processed = await uploadHomeworkAsset({ blob: photo.file, fileName: `答卷照片-${index + 1}-${photo.file.name}`, role: "submission_processed", pageOrder: index, submissionId: activeSubmission.id });
        saved.push({ originalAssetId: original.id, processedAssetId: processed.id, quality: { score: .85, warnings: ["相册原图，未进行扫描校准"], blocking: false } });
        setMessage(`正在上传第 ${index + 1}/${photos.length} 张…`);
      }
      await studentHomeworkApi.updateSubmission(activeSubmission.id, { action: "save-pages", pages: saved });
      const result = await studentHomeworkApi.updateSubmission(activeSubmission.id, { action: "submit" });
      releasePhotos();
      setActiveSubmission(null);
      await loadPortal();
      setMessage(result.submission.status === "published" ? "批改结果已完成" : "提交成功，完成后会自动显示结果");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交失败，请稍后重试");
    } finally { setBusy(false); }
  }

  async function openUploadedResult(submissionId:string) {
    setBusy(true);
    try{setResultSubmission((await studentHomeworkApi.submission(submissionId)).submission);}catch(error){setMessage(error instanceof Error?error.message:"批改记录读取失败");}finally{setBusy(false);}
  }

  async function refresh() {
    setBusy(true);
    try { await loadPortal(); setMessage("状态已更新"); }
    finally { setBusy(false); }
  }

  if (checking) return <main className="student-loading">正在进入学生作业空间…</main>;
  if (!student) return <main className="student-login-shell"><section className="student-login-card"><a href="/" className="student-logo"><span>题</span><b>Mitty 学生作业</b></a><div><p>老师代码</p><code>{teacherCode || "读取中…"}</code></div><label>学号<input autoComplete="username" value={loginId} onChange={(event) => setLoginId(event.target.value)} placeholder="请输入老师分配的学号" /></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入老师分配的密码" onKeyDown={(event) => { if (event.key === "Enter") void login(); }} /></label>{message && <p className="student-message error">{message}</p>}<button className="student-primary" disabled={busy || !teacherCode || !loginId || !password} onClick={login}>{busy ? "正在登录…" : "登录"}</button><small>账号和密码由老师统一管理。</small></section></main>;

  return <main className="student-simple-shell">
    <header className="student-simple-topbar"><div className="student-simple-logo"><span>题</span><div><b>{student.name}</b><small>学生作业</small></div></div><button onClick={logout}>退出</button></header>
    {message && <div className="student-message" role="status">{message}<button onClick={() => setMessage("")} aria-label="关闭提示">×</button></div>}
    <section className="student-simple-content"><div className="student-simple-intro"><div><p>我的作业</p><h1>提交照片，查看结果</h1><span>正常答卷会自动批改；看不清时会提示重拍。</span></div><button onClick={refresh} disabled={busy}>刷新</button></div>
      <div className="student-simple-list">{assignments.map((assignment) => {
        const submission = latestByAssignment.get(assignment.id);
        const canSubmit = !submission || ["draft", "returned", "failed"].includes(submission.status);
        const buttonText = submission?.status === "published" ? "查看结果" : submission?.status === "returned" ? "重新选择照片" : submission?.status === "draft" ? "继续选择照片" : submission ? STATUS[submission.status] : "选择照片提交";
        return <article key={assignment.id} className={`student-simple-task ${submission?.status ?? "new"}`}><div className="student-simple-task-head"><span>{submission ? STATUS[submission.status] : "待提交"}</span>{assignment.dueAt && <small>{new Date(assignment.dueAt).toLocaleString("zh-CN")} 截止</small>}</div><h2>{assignment.title}</h2><p>{assignment.instructions || "请选择完整、清晰的作业照片。"}</p>{submission?.failureReason && <p className="student-return-reason">{submission.failureReason}</p>}<button className="student-primary" disabled={busy || (!canSubmit && submission?.status !== "published")} onClick={() => openAssignment(assignment, submission)}>{buttonText}</button></article>;
      })}{!assignments.length && <div className="student-empty"><span>作</span><b>暂时没有新作业</b><p>老师布置后会显示在这里。</p></div>}</div>
      {!!submissions.filter(s=>s.inputMode==="completed_homework").length && <details className="student-uploaded-records"><summary>老师上传的作业批改记录</summary>{submissions.filter(s=>s.inputMode==="completed_homework").map(s=><article key={s.id}><b>{s.assignmentTitle}</b><p>{STATUS[s.status]}</p><button className="student-primary" disabled={busy||s.status!=="published"} onClick={()=>openUploadedResult(s.id)}>查看结果</button></article>)}</details>}
    </section>

    {activeSubmission && <div className="student-simple-sheet"><section><div className="student-simple-sheet-head"><div><span>第 {activeSubmission.version} 次提交</span><h2>{activeSubmission.assignmentTitle}</h2><p>从相册选择完整答卷，确认后提交。</p></div><button onClick={() => { releasePhotos(); setActiveSubmission(null); }} aria-label="关闭">×</button></div><button className="student-photo-picker" onClick={() => fileInput.current?.click()} disabled={busy}>＋ 从相册选择照片</button><input ref={fileInput} hidden type="file" accept="image/*" multiple onChange={(event) => { addPhotos(event.target.files); event.target.value = ""; }} />{photos.length > 0 && <div className="student-photo-list">{photos.map((photo, index) => <figure key={photo.id}><img src={photo.url} alt={`待提交照片 ${index + 1}`} /><figcaption><span>第 {index + 1} 张</span><button onClick={() => removePhoto(photo.id)} disabled={busy}>删除</button></figcaption></figure>)}</div>}<p className="student-photo-hint">已选 {photos.length} 张。请确认每一页都完整、清晰。</p><div className="student-simple-sheet-actions"><button onClick={() => { releasePhotos(); setActiveSubmission(null); }} disabled={busy}>取消</button><button className="student-primary" disabled={busy || !photos.length} onClick={submitPhotos}>{busy ? "正在上传…" : `提交 ${photos.length} 张照片`}</button></div></section></div>}

    {resultSubmission && <div className="student-result-sheet"><section><div className="student-result-head"><div><span>批改完成 · {resultSubmission.publishedAt ? new Date(resultSubmission.publishedAt).toLocaleString("zh-CN") : "刚刚更新"}</span><h2>{resultSubmission.assignmentTitle}</h2><p>{resultSubmission.report?.studentMessage || "查看本次总结和下一步建议。"}</p></div><button onClick={() => { setResultSubmission(null); }} aria-label="关闭结果">×</button></div>
      <article className="student-report-summary"><p>本次总结</p><h3>{resultSubmission.report?.overallSummary || "逐题批改已经完成"}</h3>{resultSubmission.report?.gaps.length ? <div>{resultSubmission.report.gaps.map((gap) => <span key={`${gap.title}-${gap.questionNumbers.join("-")}`}><b>{gap.title}</b><small>{gap.questionNumbers.map((number) => `第 ${number} 题`).join("、")}</small></span>)}</div> : <small>查看逐题结果；待处理题请按提示补充材料。</small>}</article>
      {!!resultSubmission.report?.actions.length && <article className="student-next-actions"><b>下一步建议</b><ol>{resultSubmission.report.actions.map((action) => <li key={action}>{action}</li>)}</ol></article>}
      <section className="student-result-details"><div><h3>逐题结果</h3><span>{resultSubmission.gradingItems.filter((item) => item.verdict === "partial" || item.verdict === "incorrect").length} 道需要重做</span></div>{resultSubmission.gradingItems.map((item) => <details key={item.id} className={item.verdict}><summary><span>第 {item.questionNumber} 题</span><b>{VERDICT[item.verdict] ?? item.verdict}</b></summary><div><p>{item.feedback}</p>{item.stepAnalysis.length > 0 && <ol>{item.stepAnalysis.map((step) => <li key={step}>{step}</li>)}</ol>}<section><b>我的作答</b><p>{item.studentAnswer || (item.errorType === "漏答" ? "空白（未作答）" : "未识别到作答")}</p></section><section><b>标准答案</b><p><MathText text={item.standardAnswer} /></p>{item.standardAnalysis && <small><MathText text={item.standardAnalysis} /></small>}</section></div></details>)}</section>
    </section></div>}
  </main>;
}
