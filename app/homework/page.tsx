"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- vinext beta currently breaks next/link RSC prefetch on these client-only pages. */

import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import { StudentArchiveTabs } from "../components/StudentArchiveTabs";
import { createStudent as createStudentProfile } from "../../lib/api-client";
import { renderImportFile } from "../../lib/file-import";
import { randomClientId } from "../../lib/client-random-id.mjs";
import { homeworkApi, uploadHomeworkAsset } from "../../lib/homework-api-client";
import type { Assignment, AssignmentQuestion, AuthUser, HomeworkClass, HomeworkSubmission, StudentSummary } from "../../lib/types";

type MainView = "assignments" | "students";
type DraftStep = 1 | 2 | 3;

const STATUS: Record<string, string> = {
  draft: "草稿", published: "已布置", closed: "已关闭", archived: "已归档", submitted: "已提交",
  processing: "批改中", review_required: "旧版待复核", ready: "旧版待发布", returned: "已退回", failed: "处理失败",
};
const SUBMISSION_STATUS: Record<string, string> = {
  draft: "答卷草稿", submitted: "已提交", processing: "批改中", review_required: "旧版待复核",
  ready: "旧版待发布", published: "结果已发布", returned: "已退回", failed: "处理失败",
};
const CAPABILITIES = [
  ["skill:calculation", "计算准确性"], ["skill:concept", "概念理解"], ["skill:reasoning", "逻辑推理"],
  ["skill:modeling", "数学建模"], ["skill:expression", "表达与步骤"],
] as const;

function dateInput(timestamp: number | null) {
  if (!timestamp) return "";
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function randomPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

async function dataUrlBlob(value: string) { return fetch(value).then((response) => response.blob()); }

function suggestedStep(assignment: Assignment | null): DraftStep {
  if (!assignment?.assets.some((asset) => asset.role === "question" && assignment.assets.some((candidate) => candidate.role === "answer"))) return 1;
  if (!assignment.questions.length) return 2;
  return 3;
}

function totalSubmissions(assignment: Assignment) {
  return Object.values(assignment.submissionCounts).reduce((sum, count) => sum + count, 0);
}

export default function HomeworkTeacherPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [classes, setClasses] = useState<HomeworkClass[]>([]);
  const [records, setRecords] = useState<HomeworkSubmission[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [activeId, setActiveId] = useState("");
  const [active, setActive] = useState<Assignment | null>(null);
  const [submissions, setSubmissions] = useState<HomeworkSubmission[]>([]);
  const [portal, setPortal] = useState<{ code: string; url: string } | null>(null);
  const [qr, setQr] = useState("");
  const [mainView, setMainView] = useState<MainView>("assignments");
  const [draftStep, setDraftStep] = useState<DraftStep>(1);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [teacherStudentId, setTeacherStudentId] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [className, setClassName] = useState("");
  const [classStudents, setClassStudents] = useState<string[]>([]);
  const [newStudentName, setNewStudentName] = useState("");
  const [accountInputs, setAccountInputs] = useState<Record<string, { loginId: string; password: string }>>({});
  const [newTitle, setNewTitle] = useState("");
  const questionInput = useRef<HTMLInputElement>(null);
  const answerInput = useRef<HTMLInputElement>(null);

  const targetSet = useMemo(() => new Set(active?.targetStudentIds ?? []), [active?.targetStudentIds]);

  async function refresh(preferred = activeId) {
    const [me, studentData, classData, assignmentData, portalData] = await Promise.all([
      homeworkApi.me(), homeworkApi.students(), homeworkApi.classes(), homeworkApi.assignments(), homeworkApi.portal(),
    ]);
    setUser(me.user);
    setStudents(studentData.students);
    setClasses(classData.classes);
    setAssignments(assignmentData.assignments);
    setRecords((await homeworkApi.submissions("")).submissions.filter(item => item.inputMode === "completed_homework"));
    setAccountInputs((current) => Object.fromEntries(studentData.students.map((student) => [student.id, {
      loginId: student.loginId, password: current[student.id]?.password ?? "",
    }])));
    setPortal(portalData);
    const id = assignmentData.assignments.some((item) => item.id === preferred) ? preferred : assignmentData.assignments[0]?.id ?? "";
    const selected = assignmentData.assignments.find((item) => item.id === id) ?? null;
    setActiveId(id);
    setActive(selected);
    setSubmissions(selected ? (await homeworkApi.submissions(selected.id)).submissions : []);
    setTeacherStudentId((current) => selected?.targetStudentIds.includes(current) ? current : selected?.targetStudentIds[0] ?? "");
    if (selected?.status === "draft") setDraftStep(suggestedStep(selected));
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (new URLSearchParams(location.search).get("view") === "students") setMainView("students");
      void refresh().catch((error) => setNotice(error instanceof Error ? error.message : "作业中心读取失败")).finally(() => setLoading(false));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!portal?.url) return;
    void QRCode.toDataURL(portal.url, { width: 180, margin: 1, color: { dark: "#1f2d27", light: "#ffffff" } }).then(setQr);
  }, [portal?.url]);

  async function chooseAssignment(id: string) {
    setActiveId(id);
    setBusy(true);
    try {
      const [assignment, submissionData] = await Promise.all([homeworkApi.readAssignment(id), homeworkApi.submissions(id)]);
      setActive(assignment.assignment);
      setSubmissions(submissionData.submissions);
      setTeacherStudentId(assignment.assignment.targetStudentIds[0] ?? "");
      if (assignment.assignment.status === "draft") setDraftStep(suggestedStep(assignment.assignment));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "作业读取失败");
    } finally { setBusy(false); }
  }

  async function createAssignment() {
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const result = await homeworkApi.createAssignment({ title: newTitle, instructions: "", targetStudentIds: [] });
      setNewTitle("");
      setMainView("assignments");
      setDraftStep(1);
      await refresh(result.assignment.id);
      setNotice("作业草稿已创建");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建失败");
    } finally { setBusy(false); }
  }

  async function saveAssignment(patch: Partial<Assignment> = {}, success = "草稿已保存") {
    if (!active) return;
    setBusy(true);
    try {
      const result = await homeworkApi.updateAssignment(active.id, { ...active, ...patch });
      setActive(result.assignment);
      await refresh(result.assignment.id);
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败");
    } finally { setBusy(false); }
  }

  async function createStudent() {
    if (!newStudentName.trim()) return;
    setBusy(true);
    try {
      await createStudentProfile({ name: newStudentName, className: "", notes: "" });
      setNewStudentName("");
      await refresh();
      setNotice("学生已创建，可以上传作业；需要学生自行提交时再设置账号");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "学生创建失败");
    } finally { setBusy(false); }
  }

  async function setAccount(student: StudentSummary) {
    const input = accountInputs[student.id] ?? { loginId: "", password: "" };
    if (!input.loginId || input.password.length < 8) { setNotice("请填写学号和至少 8 位密码"); return; }
    setBusy(true);
    try {
      await homeworkApi.setStudentAccount(student.id, input.loginId, input.password);
      setNotice(`已更新 ${student.name} 的登录账号`);
      setAccountInputs((current) => ({ ...current, [student.id]: { ...input, password: "" } }));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "账号设置失败");
    } finally { setBusy(false); }
  }

  async function createClass() {
    if (!className.trim()) return;
    setBusy(true);
    try {
      await homeworkApi.createClass(className, classStudents);
      setClassName("");
      setClassStudents([]);
      await refresh();
      setNotice("班级已创建");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "班级创建失败");
    } finally { setBusy(false); }
  }

  function selectClass(homeworkClass: HomeworkClass) {
    if (!active) return;
    setActive({ ...active, targetStudentIds: [...new Set([...active.targetStudentIds, ...homeworkClass.studentIds])] });
  }

  async function uploadTemplate(files: FileList | null, role: "question" | "answer") {
    if (!active || !files?.length) return;
    setBusy(true);
    setNotice("正在把文件转换为页面图片…");
    try {
      let pageOrder = active.assets.filter((asset) => asset.role === role).reduce((maximum, asset) => Math.max(maximum, asset.pageOrder + 1), 0);
      for (const file of [...files]) {
        const pages = file.type.startsWith("image/")
          ? [{ image: URL.createObjectURL(file), direct: file }]
          : (await renderImportFile(file, (current, total) => setNotice(`正在读取 ${file.name}：${current}/${total} 页`)))
            .map((page) => ({ image: page.image, direct: null as File | null }));
        for (const page of pages) {
          const blob = page.direct ?? await dataUrlBlob(page.image);
          await uploadHomeworkAsset({ blob, fileName: `${file.name}-第${pageOrder + 1}页.jpg`, role, pageOrder, assignmentId: active.id });
          if (page.direct) URL.revokeObjectURL(page.image);
          pageOrder += 1;
        }
      }
      const result = await homeworkApi.readAssignment(active.id);
      setActive(result.assignment);
      await refresh(active.id);
      setDraftStep(1);
      setNotice(role === "question" ? "题目卷已上传" : "答案解析已上传");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "文件上传失败");
    } finally { setBusy(false); }
  }

  async function extractTemplate() {
    if (!active) return;
    setBusy(true);
    setNotice("AI 正在整理题目、答案和能力标签…");
    try {
      const result = await homeworkApi.extractAssignment(active.id);
      setActive(result.assignment);
      await refresh(active.id);
      setDraftStep(2);
      setNotice("模板识别完成，请检查后继续");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "模板识别失败");
    } finally { setBusy(false); }
  }

  function updateQuestion(id: string, patch: Partial<AssignmentQuestion>) {
    if (!active) return;
    setActive({ ...active, questions: active.questions.map((question) => question.id === id ? { ...question, ...patch } : question) });
  }

  function moveQuestion(id: string, offset: number) {
    if (!active) return;
    const index = active.questions.findIndex((question) => question.id === id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= active.questions.length) return;
    const questions = [...active.questions];
    [questions[index], questions[target]] = [questions[target], questions[index]];
    setActive({ ...active, questions: questions.map((question, sortOrder) => ({ ...question, sortOrder })) });
  }

  function addQuestion() {
    if (!active) return;
    const index = active.questions.length;
    setActive({ ...active, questions: [...active.questions, {
      id: randomClientId(), assignmentId: active.id, questionNumber: String(index + 1), pageNumber: 1, type: "解答题",
      stem: "", options: [], answer: "", analysis: "", bbox: null, confidence: 1,
      warnings: ["教师手动新增，请确认题目页码与边界"], knowledgeTags: [], capabilityKeys: [],
      sortOrder: index, createdAt: Date.now(), updatedAt: Date.now(),
    }] });
  }

  function removeQuestion(id: string) {
    if (!active || !window.confirm("确认删除这道作业题目？保存模板后生效。")) return;
    setActive({ ...active, questions: active.questions.filter((question) => question.id !== id).map((question, sortOrder) => ({ ...question, sortOrder })) });
  }

  async function publishAssignment() {
    if (!active || !window.confirm("确认布置？学生将能看到题目并提交，题目模板会被锁定。")) return;
    setBusy(true);
    try {
      const result = await homeworkApi.updateAssignment(active.id, { ...active, action: "publish" });
      setActive(result.assignment);
      await refresh(result.assignment.id);
      setNotice("作业已布置，正常答卷批改完成后自动发布，错题自动归档");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "布置失败");
    } finally { setBusy(false); }
  }

  async function teacherUpload() {
    if (!active || !teacherStudentId) return;
    setBusy(true);
    try {
      const result = await homeworkApi.createSubmission(active.id, teacherStudentId);
      window.location.href = `/homework/submissions/${result.submission.id}`;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "代传入口创建失败");
      setBusy(false);
    }
  }

  if (loading) return <main className="homework-loading">正在打开作业批改中心…</main>;
  if (!user) return <main className="homework-loading"><h1>请先登录教师账号</h1><a href="/">返回题库登录</a></main>;

  const submittedCount = active ? totalSubmissions(active) : 0;
  const publishedCount = active?.submissionCounts.published ?? 0;
  const attentionCount = active ? (active.submissionCounts.returned ?? 0) + (active.submissionCounts.failed ?? 0) : 0;

  return <main className="homework-shell">
    <header className="homework-topbar">
      <a href="/?view=wrong-book" className="homework-brand"><span>题</span><b>学生档案</b></a>
      <StudentArchiveTabs active="homework" />
      <div><span>{user.local ? "本地管理员" : user.email}</span><button className="student-management-toggle" onClick={() => setMainView(mainView === "students" ? "assignments" : "students")}>{mainView === "students" ? "返回作业" : "学生管理"}</button><a href="/">返回题库</a></div>
    </header>
    {notice && <div className="homework-notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="关闭提示">×</button></div>}

    <section className="completed-homework-entry"><div><h1>作业批改与记录</h1><p>上传学生已完成的作业，Agent 自动批改并归档完全错误的题目。</p></div><a className="primary" href="/homework/upload">上传作业并批改</a></section>
    {!!records.length && <details className="homework-panel completed-records" open><summary>已上传作业记录（{records.length}）</summary><div>{records.map(record=><a className="completed-record" key={record.id} href={`/homework/submissions/${record.id}`}><span><b>{record.studentName} · {record.assignmentTitle}</b><small>{new Date(record.createdAt).toLocaleString("zh-CN")}</small></span><span>{SUBMISSION_STATUS[record.status]}{record.gradingSummary && <small>{record.gradingSummary.archived} 道错题 · {record.gradingSummary.unresolved} 道待处理</small>}</span></a>)}</div></details>}
    {mainView === "students" ? <section className="homework-students-view">
      <div className="homework-section-hero"><div><p>学生与班级</p><h1>统一管理学生登录</h1><span>密码只由老师创建或重置，学生不能自行修改。</span></div></div>
      <div className="student-management-grid">
        <section className="homework-panel student-onboard-card"><div className="panel-heading"><div><b>新增学生</b><p>老师代传无需学生登录，自行提交时可设置账号</p></div></div><div className="single-action-form"><input value={newStudentName} onChange={(event) => setNewStudentName(event.target.value)} placeholder="学生姓名或昵称" onKeyDown={(event) => { if (event.key === "Enter") void createStudent(); }} /><button className="primary" onClick={createStudent} disabled={busy || !newStudentName.trim()}>新建学生</button></div></section>
        <section className="homework-panel student-onboard-card"><div className="panel-heading"><div><b>新建班级</b><p>可在创建时勾选班级成员</p></div></div><div className="single-action-form"><input value={className} onChange={(event) => setClassName(event.target.value)} placeholder="班级名称" /><button className="primary" onClick={createClass} disabled={busy || !className.trim()}>创建班级</button></div>{className && <div className="class-member-picker">{students.map((student) => <label key={student.id}><input type="checkbox" checked={classStudents.includes(student.id)} onChange={(event) => setClassStudents(event.target.checked ? [...classStudents, student.id] : classStudents.filter((id) => id !== student.id))} />{student.name}</label>)}</div>}</section>
        <section className="homework-panel student-access-card"><div className="panel-heading"><div><b>学生入口</b><p>同一入口按学号区分学生</p></div></div><div>{qr && <img src={qr} alt="学生入口二维码" />}<span><code>{portal?.url}</code><small>将二维码或链接发给学生</small></span></div></section>
      </div>
      {!!classes.length && <section className="class-overview">{classes.map((item) => <article key={item.id}><span>{item.studentIds.length}</span><div><b>{item.name}</b><small>{item.studentIds.map((id) => students.find((student) => student.id === id)?.name).filter(Boolean).join("、") || "暂无成员"}</small></div></article>)}</section>}
      <section className="homework-panel account-panel"><div className="panel-heading"><div><b>学生账号</b><p>密码不会回显；需要更换时直接由老师重置</p></div></div><div className="student-account-list">{students.map((student) => { const input = accountInputs[student.id] ?? { loginId: "", password: "" }; return <div key={student.id}><span><b>{student.name}</b><small>{student.className || "未分班"}</small></span><input value={input.loginId} onChange={(event) => setAccountInputs((current) => ({ ...current, [student.id]: { ...input, loginId: event.target.value } }))} placeholder="学号" /><input type="password" value={input.password} onChange={(event) => setAccountInputs((current) => ({ ...current, [student.id]: { ...input, password: event.target.value } }))} placeholder="新密码（至少 8 位）" /><button onClick={() => setAccountInputs((current) => ({ ...current, [student.id]: { ...input, password: randomPassword() } }))}>生成密码</button><button className="primary" onClick={() => setAccount(student)} disabled={busy}>保存账号</button></div>; })}</div></section>
    </section> : <details className="template-homework-section" open={Boolean(active)}><summary>布置作业模板（可选）</summary><section className="homework-layout">
      <aside className="homework-sidebar"><div className="homework-side-title"><p>作业</p><b>{assignments.length}</b></div><div className="homework-new"><input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="新作业名称" onKeyDown={(event) => { if (event.key === "Enter") void createAssignment(); }} /><button onClick={createAssignment} disabled={busy || !newTitle.trim()} aria-label="创建作业">＋</button></div><nav>{assignments.map((assignment) => <button key={assignment.id} className={assignment.id === activeId ? "active" : ""} onClick={() => chooseAssignment(assignment.id)}><span>{STATUS[assignment.status]}</span><b>{assignment.title}</b><small>{assignment.targetStudentIds.length} 名学生 · {totalSubmissions(assignment)} 次提交</small></button>)}</nav></aside>
      <section className="homework-main">
        {!active ? <div className="homework-empty"><span>作</span><h1>先选择或创建作业模板</h1><p>此功能用于提前布置统一作业；批改已完成作业可直接使用上方上传入口。</p></div> : <>
          <div className="homework-title-row"><div><span>{STATUS[active.status]}</span><input value={active.title} disabled={active.status !== "draft"} onChange={(event) => setActive({ ...active, title: event.target.value })} /><p>{active.status === "draft" ? "完成三个步骤即可布置" : `已布置给 ${active.targetStudentIds.length} 名学生`}</p></div>{active.status === "draft" ? <button className="primary homework-publish-action" onClick={publishAssignment} disabled={busy || !active.questions.length || !active.targetStudentIds.length}>布置作业</button> : active.status === "published" ? <button className="primary homework-publish-action" onClick={() => setUploadOpen(true)} disabled={busy || !active.targetStudentIds.length}>代传答卷</button> : null}</div>
          {active.status === "draft" ? <>
            <nav className="draft-steps" aria-label="草稿制作步骤">{[{ id: 1, title: "资料上传", note: `${active.assets.length} 页` }, { id: 2, title: "AI 模板", note: `${active.questions.length} 题` }, { id: 3, title: "布置范围", note: `${active.targetStudentIds.length} 人` }].map((step) => <button key={step.id} className={draftStep === step.id ? "active" : ""} onClick={() => setDraftStep(step.id as DraftStep)}><span>{step.id}</span><b>{step.title}</b><small>{step.note}</small></button>)}</nav>
            {draftStep === 1 && <section className="homework-panel draft-stage"><div className="panel-heading"><div><b>上传题目卷和答案</b><p>支持图片、PDF、DOCX，原件私密保存</p></div></div><div className="template-upload-grid"><button onClick={() => questionInput.current?.click()}><span>题</span><b>上传题目卷</b><small>{active.assets.filter((asset) => asset.role === "question").length} 页</small></button><button onClick={() => answerInput.current?.click()}><span>答</span><b>上传答案解析</b><small>{active.assets.filter((asset) => asset.role === "answer").length} 页</small></button></div><input ref={questionInput} hidden type="file" multiple accept="image/*,.pdf,.docx" onChange={(event) => { void uploadTemplate(event.target.files, "question"); event.target.value = ""; }} /><input ref={answerInput} hidden type="file" multiple accept="image/*,.pdf,.docx" onChange={(event) => { void uploadTemplate(event.target.files, "answer"); event.target.value = ""; }} />{!!active.assets.length && <details className="low-frequency"><summary>查看已上传页面</summary><div className="template-assets">{(["question", "answer"] as const).map((role) => <div key={role}><b>{role === "question" ? "题目卷" : "答案解析"}</b><div>{active.assets.filter((asset) => asset.role === role).sort((left, right) => left.pageOrder - right.pageOrder).map((asset, index) => <figure key={asset.id}><img src={asset.url} alt={`${role === "question" ? "题目卷" : "答案"}第 ${index + 1} 页`} /><figcaption>第 {index + 1} 页</figcaption></figure>)}</div></div>)}</div></details>}<div className="stage-action"><button className="primary" disabled={busy || !active.assets.some((asset) => asset.role === "question") || !active.assets.some((asset) => asset.role === "answer")} onClick={extractTemplate}>AI 生成模板</button></div></section>}
            {draftStep === 2 && <section className="homework-panel draft-stage"><div className="panel-heading"><div><b>确认 AI 模板</b><p>默认只看题号与答案，展开题目可检查证据和能力标签</p></div><button onClick={addQuestion}>新增题目</button></div>{!active.questions.length ? <div className="assignment-question-empty"><b>还没有题目模板</b><p>回到“资料上传”运行 AI 识别，或手动新增题目。</p></div> : <div className="assignment-questions compact">{active.questions.map((question, index) => <details key={question.id} className={question.warnings.length ? "warning" : ""}><summary><span>第 {question.questionNumber} 题</span><b>{question.answer || "答案待补充"}</b><small>{question.type} · 第 {question.pageNumber} 页</small></summary><div className="question-editor"><div className="question-editor-row"><label>题号<input value={question.questionNumber} onChange={(event) => updateQuestion(question.id, { questionNumber: event.target.value })} /></label><label>页码<input type="number" min={1} max={200} value={question.pageNumber} onChange={(event) => updateQuestion(question.id, { pageNumber: Math.max(1, Number(event.target.value) || 1) })} /></label><label>题型<select value={question.type} onChange={(event) => updateQuestion(question.id, { type: event.target.value as AssignmentQuestion["type"] })}>{["单选题", "多选题", "填空题", "判断题", "解答题"].map((type) => <option key={type}>{type}</option>)}</select></label></div><label>题干<textarea rows={3} value={question.stem} onChange={(event) => updateQuestion(question.id, { stem: event.target.value })} /></label><div className="question-answer-grid"><label>标准答案<textarea rows={2} value={question.answer} onChange={(event) => updateQuestion(question.id, { answer: event.target.value })} /></label><label>标准解析<textarea rows={2} value={question.analysis} onChange={(event) => updateQuestion(question.id, { analysis: event.target.value })} /></label></div><details className="question-more"><summary>更多信息</summary><label>知识点（用逗号分隔）<input value={question.knowledgeTags.join("，")} onChange={(event) => updateQuestion(question.id, { knowledgeTags: event.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean) })} /></label><div className="capability-picker">{CAPABILITIES.map(([key, label]) => <label key={key}><input type="checkbox" checked={question.capabilityKeys.includes(key)} onChange={(event) => updateQuestion(question.id, { capabilityKeys: event.target.checked ? [...question.capabilityKeys, key] : question.capabilityKeys.filter((item) => item !== key) })} />{label}</label>)}</div></details>{question.warnings.length > 0 && <p className="question-warning">{question.warnings.join("；")}</p>}<div className="question-quiet-actions"><button disabled={index === 0} onClick={() => moveQuestion(question.id, -1)}>上移</button><button disabled={index === active.questions.length - 1} onClick={() => moveQuestion(question.id, 1)}>下移</button><button className="danger" onClick={() => removeQuestion(question.id)}>删除</button></div></div></details>)}</div>}<div className="stage-action"><button className="primary" disabled={busy || !active.questions.length} onClick={() => { void saveAssignment({}, "模板已保存"); setDraftStep(3); }}>保存并继续</button></div></section>}
            {draftStep === 3 && <section className="homework-panel draft-stage"><div className="panel-heading"><div><b>选择布置范围</b><p>先选班级，再按需增减学生</p></div></div><div className="homework-form-grid"><label>作业说明<textarea rows={3} value={active.instructions} onChange={(event) => setActive({ ...active, instructions: event.target.value })} /></label><label>截止时间（选填）<input type="datetime-local" value={dateInput(active.dueAt)} onChange={(event) => setActive({ ...active, dueAt: event.target.value ? new Date(event.target.value).getTime() : null })} /></label></div>{!!classes.length && <div className="class-shortcuts">{classes.map((item) => <button key={item.id} onClick={() => selectClass(item)}>＋ {item.name}（{item.studentIds.length}）</button>)}</div>}<div className="target-students">{students.map((student) => <label key={student.id}><input aria-label={`布置给 ${student.name}`} type="checkbox" checked={targetSet.has(student.id)} onChange={(event) => setActive({ ...active, targetStudentIds: event.target.checked ? [...active.targetStudentIds, student.id] : active.targetStudentIds.filter((id) => id !== student.id) })} /><span><b>{student.name}</b><small>{student.className || "未分班"}</small></span></label>)}</div>{!students.length && <div className="assignment-question-empty"><b>还没有学生</b><p>请打开“学生管理”创建学生档案。</p></div>}<div className="stage-action"><button onClick={() => saveAssignment()} disabled={busy}>保存草稿</button><button className="primary" onClick={publishAssignment} disabled={busy || !active.targetStudentIds.length || !active.questions.length}>布置作业</button></div></section>}
          </> : <><section className="assignment-overview"><article><span>{active.targetStudentIds.length}</span><b>已布置学生</b></article><article><span>{submittedCount}</span><b>提交版本</b></article><article><span>{publishedCount}</span><b>已出结果</b></article><article className={attentionCount ? "attention" : ""}><span>{attentionCount}</span><b>需处理异常</b></article></section><section className="homework-panel"><div className="panel-heading"><div><b>提交概览</b><p>批改后完全错误的题目自动归档；看不清的题目单独待处理</p></div></div><div className="submission-table"><div className="submission-row heading"><span>学生</span><span>版本</span><span>状态</span><span>更新时间</span><span></span></div>{submissions.map((submission) => <div className="submission-row" key={submission.id}><a className="submission-student-link" href={`/?view=wrong-book&studentId=${encodeURIComponent(submission.studentId)}`}>{submission.studentName}</a><span>第 {submission.version} 版</span><span className={`submission-status ${submission.status}`}>{SUBMISSION_STATUS[submission.status] ?? submission.status}</span><span>{new Date(submission.updatedAt).toLocaleString("zh-CN")}</span><a href={`/homework/submissions/${submission.id}`}>{submission.status === "draft" ? "继续上传" : "查看详情"}</a></div>)}</div>{!submissions.length && <div className="assignment-question-empty"><b>还没有提交</b><p>学生提交后会在这里显示处理状态。</p></div>}</section><details className="homework-panel assignment-more"><summary>作业设置与低频操作</summary><div><p>{active.instructions || "未填写作业说明"}</p><p>{active.questions.length} 道题 · {active.assets.length} 页资料</p><div className="assignment-more-actions">{qr && <button onClick={() => setMainView("students")}>查看学生入口</button>}{active.status === "published" && <button onClick={() => saveAssignment({ action: "close" } as Partial<Assignment>, "作业已关闭")} disabled={busy}>关闭作业</button>}</div></div></details></>}
        </>}
      </section>
    </section></details>}
    {uploadOpen && active && <div className="homework-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setUploadOpen(false); }}><section className="teacher-upload-modal" role="dialog" aria-modal="true" aria-labelledby="teacher-upload-title"><div><span>代传答卷</span><h2 id="teacher-upload-title">选择学生</h2><p>进入后从电脑或手机上传这名学生的答卷。</p></div><label>学生<select value={teacherStudentId} onChange={(event) => setTeacherStudentId(event.target.value)}>{active.targetStudentIds.map((id) => <option key={id} value={id}>{students.find((student) => student.id === id)?.name ?? id}</option>)}</select></label><div><button onClick={() => setUploadOpen(false)}>取消</button><button className="primary" onClick={teacherUpload} disabled={!teacherStudentId || busy}>继续上传</button></div></section></div>}
  </main>;
}
