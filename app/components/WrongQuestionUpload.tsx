"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import HomeworkPagePicker, { homeworkPage, releaseHomeworkPages, type HomeworkPage } from "./HomeworkPagePicker";
import { CURRICULA, GRADING_STATUSES, useHomeworkUpload } from "./use-homework-upload";
import { homeworkApi } from "../../lib/homework-api-client";
import { droppedImage } from "../../lib/screenshot-recognition";
import type { HomeworkCurriculum, HomeworkSubmission, StudentSummary } from "../../lib/types";

type Mode = "screenshot" | "file";
const MODES: Array<[Mode, string]> = [["screenshot", "截图"], ["file", "整份作业"]];
const WRONG_BOOK_ONLY = { wrongBook: true, report: false, profile: false };
// Both entries start with a dated name, so the only required step is choosing the pages.
const datedTitle = (mode: Mode) => { const today = new Date(); return `${today.getMonth() + 1}月${today.getDate()}日${mode === "screenshot" ? "截图错题" : "作业"}`; };

/** 新建错题：录入方式与新建试题相同（单题截图 / 整份文件）；批改与工具箱“作业批改”同一条路径，结果只写入错题本。 */
export default function WrongQuestionUpload({ student, onClose, onGraded }: { student: StudentSummary; onClose(): void; onGraded(submission: HomeworkSubmission): void }) {
  const [mode, setMode] = useState<Mode>("screenshot");
  const [pages, setPages] = useState<HomeworkPage[]>([]), [documents, setDocuments] = useState<File[]>([]), [references, setReferences] = useState<File[]>([]);
  const [title, setTitle] = useState(() => datedTitle("screenshot")), [pickerBusy, setPickerBusy] = useState(false), [captureError, setCaptureError] = useState("");
  const [submitted, setSubmitted] = useState<HomeworkSubmission | null>(null);
  const upload = useHomeworkUpload(), { curriculum, busy, draft, referencesSaved } = upload;
  const captureRef = useRef<HTMLInputElement>(null);
  const grading = !!submitted && GRADING_STATUSES.includes(submitted.status), failed = submitted?.status === "failed";

  const capture = useCallback(async (file: Blob) => {
    setCaptureError("");
    try { const page = await homeworkPage(file); setPages((current) => { releaseHomeworkPages(current); return [page]; }); }
    catch (error) { setCaptureError(error instanceof Error ? error.message : "图片读取失败"); }
  }, []);
  // ⌘V works as soon as the dialog opens, like the library's screenshot entry.
  useEffect(() => {
    if (mode !== "screenshot" || submitted) return;
    const paste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.items ?? [])].find((item) => item.type.startsWith("image/"))?.getAsFile();
      if (file) { event.preventDefault(); void capture(file); }
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, [mode, submitted, capture]);
  useEffect(() => {
    if (!submitted || !GRADING_STATUSES.includes(submitted.status)) return;
    const timer = setTimeout(() => { void homeworkApi.submission(submitted.id).then(({ submission }) => { setSubmitted(submission); if (!GRADING_STATUSES.includes(submission.status)) onGraded(submission); }).catch(() => setSubmitted({ ...submitted })); }, 4000);
    return () => clearTimeout(timer);
  }, [submitted, onGraded]);

  function switchMode(next: Mode) {
    if (next === mode) return;
    releaseHomeworkPages(pages); setPages([]); setDocuments([]); setCaptureError(""); setMode(next); setTitle(datedTitle(next));
  }
  async function submit() {
    if (!pages.length || !title.trim() || busy || pickerBusy) return;
    // A single screenshot is only judged right or wrong: it keeps its automatic name and the school grading path.
    const result = await upload.start({ studentId: student.id, title, outputs: WRONG_BOOK_ONLY, pages, documents, references: mode === "screenshot" ? [] : references, ...(mode === "screenshot" ? { curriculum: "school" as const } : {}) });
    if (result) setSubmitted(result);
  }

  const international = curriculum === "international";
  const details = submitted && <a href={`/tools/homework/submissions/${submitted.id}`}>查看批改详情</a>;
  const fields = !submitted && mode === "file" && !!pages.length && <div className="wrong-entry-fields">
    <div className="form-grid two"><label>作业名称<input value={title} disabled={busy || !!draft} onChange={(event) => setTitle(event.target.value)} placeholder={international ? "例如：9709 P1 Week 3 Quiz" : "例如：一元一次方程练习"} /></label><label>课程<select aria-label="课程" value={curriculum} disabled={busy || !!draft} onChange={(event) => upload.chooseCurriculum(event.target.value as HomeworkCurriculum)}>{CURRICULA.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <details className="completed-reference" open={international || undefined}><summary>{international ? "Mark Scheme（建议上传）" : "参考答案（选填）"}</summary><p>{international ? "有 mark scheme 时逐个得分点对照；未提供时由 Agent 按考试局惯例拟定得分点并校验。" : "有答案时优先使用；未提供时由 Agent 独立解题并校验。"}</p><input type="file" aria-label="上传参考答案" accept="image/*,application/pdf" multiple disabled={busy || referencesSaved} onChange={(event) => setReferences([...(event.target.files ?? [])])} />{references.map((file, index) => <p key={index}>{file.name}</p>)}</details>
  </div>;

  return <div className="modal-backdrop"><section className="modal wrong-entry" role="dialog" aria-modal="true" aria-label={`给${student.name}新建错题`} aria-busy={busy && !submitted}>
    <header className="wrong-entry-head"><h2>新建错题<span>{student.name}</span></h2><button className="close" aria-label="关闭" disabled={busy && !submitted} onClick={onClose}>×</button></header>
    <div className="wrong-entry-modes" role="tablist" aria-label="录入方式">{MODES.map(([value, label]) => <button key={value} role="tab" aria-selected={mode === value} disabled={mode !== value && (busy || !!draft)} onClick={() => switchMode(value)}>{label}</button>)}</div>
    {upload.message && <div className="homework-notice" role="status">{upload.message}</div>}
    {mode === "screenshot" ? <>
      {!pages.length ? <button type="button" className="wrong-entry-drop" onClick={() => captureRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = droppedImage(event); if (file) void capture(file); else setCaptureError("请选择图片文件"); }}>
        <kbd>⌘V</kbd><span><b>粘贴错题截图</b><small>或点击选择、拖入图片。截图要包含题目和学生的作答。</small></span>
      </button> : <div className="recognition-source">
        <div className="source-image"><img src={pages[0].url} alt="学生作答截图" />{(busy || grading) && !failed && <div className="recognizing"><i></i><b>{grading ? "正在批改…" : "正在上传…"}</b><span>判错后自动收录进错题本</span></div>}</div>
        <div className="source-status"><b>{failed ? "自动批改遇到问题" : grading ? "正在自动批改" : "截图已就绪"}</b><p>{failed ? submitted.failureReason || "可在批改详情中重新批改" : grading ? "完成后自动收录，可以先关闭窗口。" : "确认截图包含题目和学生的作答。"}</p><div>{details || <button className="text-button" disabled={busy} onClick={() => { releaseHomeworkPages(pages); setPages([]); }}>换一张</button>}</div></div>
      </div>}
      <input ref={captureRef} hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void capture(file); event.target.value = ""; }} />
      {captureError && <div className="recognition-error"><b>图片未能读取</b><span>{captureError}</span></div>}
    </> : submitted ? <div className="file-processing homework-upload-status" role="status">{grading && <div className="file-spinner"><i></i>批改中</div>}<h3>{failed ? "自动批改遇到问题" : grading ? "正在自动批改" : "批改完成"}</h3><p>{failed ? submitted.failureReason || "可在批改详情中重新批改" : `已批改 ${submitted.processingProgress?.graded ?? 0} 道，完成后错题自动收录，可以先关闭窗口`}</p>{details}</div>
      : <HomeworkPagePicker pages={pages} onChange={setPages} disabled={busy} onBusyChange={setPickerBusy} onSourceFile={(file) => setDocuments((current) => [...current, file])} empty={<><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h7l4 4v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M15 3v4h4M9 12h6M9 16h6" /></svg><span><b>选择或拖入整份作业</b><small>照片或 PDF，最多 30 页。看不清的题单独待处理。</small></span></>} />}
    {fields}
    {!submitted && <footer className="wrong-entry-foot"><p>{mode === "screenshot" ? "判错的题自动收录进错题本" : "完全错误的题按月收录进错题本"}</p><button className="primary-button" disabled={busy || pickerBusy || !pages.length || !title.trim()} onClick={submit}>{busy ? "正在提交…" : "批改并收录"}</button></footer>}
  </section></div>;
}
