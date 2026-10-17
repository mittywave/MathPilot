"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { SiteHeader } from "../../../../components/SiteHeader";
import { PaperMoreMenu } from "../../../../components/PaperMoreMenu";
import { fetchMe } from "../../../../../lib/api-client";
import { AssignedHomeworkSheet, confirmGivingUp, dayNote, resultState, uploadNote, VerdictTally } from "../../../../components/AssignedHomeworkSheet";
import HomeworkPagePicker, { releaseHomeworkPages, type HomeworkPage } from "../../../../components/HomeworkPagePicker";
import { MathText } from "../../../../components/MathText";
import { homeworkApi, uploadHomeworkAsset } from "../../../../../lib/homework-api-client";
import { homeworkQuestionLabel, isPendingGradingItem, reconcileHomeworkScore, titleWithoutStudent } from "../../../../../lib/homework-grading-rules.mjs";
import type { AuthUser, GradingItem, HomeworkSubmission, InternationalReport, Question } from "../../../../../lib/types";

const STATUS: Record<string, string> = {
  draft: "待上传", submitted: "已提交", processing: "自动批改中", review_required: "旧版待复核",
  ready: "旧版待发布", published: "结果已发布", failed: "处理失败",
};
const OUTPUT_LABELS = [["wrongBook", "写入错题本"], ["report", "生成错题报告"], ["profile", "计入定档"]] as const;
const VERDICT: Record<string, string> = { correct: "正确", partial: "部分正确", incorrect: "错误", unreadable: "待补图", review_required: "待核实" };
function verdictLabel(item: GradingItem, international: boolean) {
  const label = !international && item.verdict === "partial" ? "错误" : international && item.verdict === "unreadable" ? "看不清" : VERDICT[item.verdict] ?? item.verdict;
  return item.maxScore != null && item.score != null ? `${label} · ${item.score}/${item.maxScore} 分` : label;
}
type Coverage = NonNullable<HomeworkSubmission["pageCoverage"]>;
type PageInfo = Coverage["pages"][number];
const PAGE_LABEL: Record<string, string> = { read: "已读取", blank: "空白页", unreadable: "待补图", waiting: "待读取", retrying: "重试中", error: "未完成" };
// An assigned sheet's pages are searched for its own questions: a page without them may be blank, scratch work or another homework.
const pageLabel = (state: string, assigned: boolean) => state === "blank" && assigned ? "无本作业题目" : PAGE_LABEL[state];
function pageState(info: PageInfo | undefined, live: boolean) {
  if (info?.valid) return info.kind === "blank" ? "blank" : info.kind === "unreadable" ? "unreadable" : "read";
  return info?.reason ? live ? "retrying" : "error" : "waiting";
}
// Failed pages usually share one cause; one line per cause reads better than one line per page.
// When the run failed, also say why each read page held no questions: it is usually the wrong file.
function pageFailures(coverage: Coverage, failed = false) {
  const causes = new Map<string, number[]>();
  for (const page of coverage.pages) if ((!page.valid || (failed && page.kind === "blank")) && page.reason) causes.set(page.reason, [...causes.get(page.reason) ?? [], page.pageNumber]);
  return [...causes].map(([reason, pages]) => `第 ${pages.join("、")} 页：${reason}`);
}

const STAGES = ["读取页面", "识别题目", "准备参考答案", "逐题批改"];
/** While grading runs: the four pipeline stages, every page as it is read, and each verdict as soon as it is saved. */
function LiveBoard({ submission, international, busy, onRetry, onCancel }: { submission: HomeworkSubmission; international: boolean; busy: boolean; onRetry(): void; onCancel(): void }) {
  const coverage = submission.pageCoverage, failed = submission.status === "failed";
  // While the queue waits to retry, the server keeps the run in progress and leaves its note here.
  const retrying = !failed && !!submission.failureReason;
  const { identified, referenceChecked, graded } = submission.processingProgress ?? { identified: 0, referenceChecked: 0, graded: 0 };
  const total = coverage?.total || submission.pages.length, read = coverage?.processed ?? 0;
  // The server's own rule for "graded in this run": rewritten since submission, or confirmed by the teacher.
  const fresh = submission.gradingItems.filter((item) => item.updatedAt >= (submission.submittedAt ?? 0) || (item.reviewedAt != null && !item.requiresReview));
  const current = read < total ? 0 : !identified ? 1 : referenceChecked < identified ? 2 : 3;
  const stages: Array<[number, number | null]> = [[read, total], [identified, null], [referenceChecked, identified], [graded, identified]];
  const recent = [...fresh].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const failures = coverage ? pageFailures(coverage, failed) : [];
  // Every page was read and none holds a question of this homework: grading it again gives the same answer, only new pages help.
  const wrongPages = failed && total > 0 && read >= total && !identified;
  // An upload that was published before keeps its results; only a first run can be emptied and uploaded again.
  const reupload = submission.publishedAt == null && <button className={wrongPages ? "primary" : undefined} onClick={onCancel} disabled={busy}
    title={failed ? "放弃这次上传，回到待上传，重新选页面" : "传错了页面时停止这次批改，回到待上传，重新选页面"}>{failed ? "重新上传" : "停止批改，重新上传"}</button>;
  return <section className={`live-board${failed ? " failed" : retrying ? " retrying" : ""}`} aria-label="批改进度">
    <header><div><h2>{failed ? "自动批改遇到问题" : current === 2 && graded > 0 ? "正在准备参考答案并批改" : `正在${STAGES[current]}`}</h2><p role="status">{failed ? submission.failureReason || "已完成的部分已保存，可以重新批改。" : retrying ? `${submission.failureReason}。已完成的部分会保留，无需操作。` : "可以离开本页，结果完成后会自动保存。"}</p></div><div className="live-actions">{reupload}{failed && !wrongPages && <button className="primary" onClick={onRetry} disabled={busy}>{read < total ? "补全页面并重新批改" : "重新批改"}</button>}</div></header>
    <ol className="live-stages">{STAGES.map((label, index) => {
      const [value, max] = stages[index], state = index < current ? "done" : index > current && !(index === 3 && graded > 0) ? "waiting" : failed ? "stalled" : "active";
      const fill = max ? Math.min(1, value / max) : index < current ? 1 : 0;
      return <li key={label} className={state}><span>{label}</span><b>{state === "waiting" && !value ? "—" : <>{value}<small>{max == null ? " 道" : ` / ${max}`}</small></>}</b><i><em style={{ width: `${fill * 100}%` }} /></i></li>;
    })}</ol>
    <div className="live-body">
      <div className="page-map">{submission.pages.map((page) => {
        const info = coverage?.pages.find((entry) => entry.pageNumber === page.pageOrder + 1), state = pageState(info, !failed);
        const marks = fresh.filter((item) => item.pageId === page.id), wrong = marks.filter((item) => resultState(item, international) === "incorrect").length;
        return <figure key={page.id} className={`page-tile ${state}`} title={info?.reason || undefined}>
          <div><img src={page.processedUrl} alt={`第 ${page.pageOrder + 1} 页`} loading="lazy" />{marks.filter((item) => item.bbox).map((item) => <i key={item.id} className={`tile-mark ${resultState(item, international)}`} style={{ left: `${(item.bbox!.x + item.bbox!.width / 2) / 10}%`, top: `${(item.bbox!.y + item.bbox!.height / 2) / 10}%` }} />)}</div>
          <figcaption><span>{page.pageOrder + 1}</span><small>{marks.length ? `${marks.length} 题${wrong ? ` · ${wrong} 错` : ""}` : pageLabel(state, Boolean(submission.assigned))}</small></figcaption>
        </figure>;
      })}</div>
      <aside className="live-results">
        {current === 3 || fresh.length ? <>
          <h3>已批改 <b>{fresh.length}</b>{identified > 0 && <small> / {identified} 道</small>}</h3>
          <VerdictTally items={fresh} total={identified} international={international} />
          {recent.length ? <ol className="live-feed">{recent.map((item) => <li key={item.id} className={resultState(item, international)}><b>{homeworkQuestionLabel(item.questionNumber)}</b><span>{verdictLabel(item, international)}</span>{item.errorType && <small>{item.errorType}</small>}</li>)}</ol> : <p className="live-empty">批改完成的题目会逐一出现在这里。</p>}
        </> : <div className="live-waiting"><h3>逐题批改还没开始</h3><p>{current === 2 ? `AI 正在为每道题准备参考答案（${referenceChecked} / ${identified} 道），每批准备好后立即批改。` : "读取页面、识别题目之后，AI 会分批准备参考答案，每批核验完成后立即批改。"}批改结果会实时出现在这里。</p></div>}
        {failures.map((line) => <p key={line} className="live-failure">{line}</p>)}
      </aside>
    </div>
  </section>;
}
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** IGCSE / A Level: display the same report as the PDF; downloads live in the shared trail. */
function InternationalReportCard({ report }: { report: InternationalReport }) {
  return <article className="submission-report-card international-report"><header><span>批改报告 · 家长与学生共读</span><h2>{report.priorities.length ? `优先改进：${report.priorities.join("、")}` : "本次没有需要优先改进的问题"}</h2><p className="report-overview"><MathText text={report.overview} /></p></header>
    {report.practice.length > 0 && <section className="report-actions"><b>下一步练习</b><ol>{report.practice.map((row) => <li key={row.action}><MathText text={row.action} /><small>完成标准：<MathText text={row.standard} /></small></li>)}</ol></section>}
    {report.losses.length > 0 && <details className="report-losses"><summary>失分分析与订正（{report.losses.length} 项）</summary>{report.losses.map((loss) => <section key={`${loss.questionNumbers.join("-")}-${loss.title}`}><strong>第 {loss.questionNumbers.join("、")} 题：<MathText text={loss.title} /></strong>{([["失分事实", loss.fact], ["知识与能力", loss.knowledge], ["正确思路", loss.method], ["订正动作", loss.action]] as const).filter(([, value]) => value).map(([label, value]) => <p key={label}><b>{label}</b><MathText text={value} /></p>)}</section>)}</details>}
  </article>;
}

export default function TeacherSubmissionPage() {
  const [id, setId] = useState("");
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [submission, setSubmission] = useState<HomeworkSubmission | null>(null);
  const [items, setItems] = useState<GradingItem[]>([]);
  const [pages, setPages] = useState<HomeworkPage[]>([]);
  const [supplementPageId, setSupplementPageId] = useState("");
  const [supplementPages, setSupplementPages] = useState<HomeworkPage[]>([]);
  const [sourceDocuments, setSourceDocuments] = useState<File[]>([]);
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [editingId, setEditingId] = useState("");
  const [activeItemId, setActiveItemId] = useState("");
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const scrolledDay = useRef<number | null>(null);
  const [dayEvidence, setDayEvidence] = useState<{ day: number; submission: HomeworkSubmission; uploads: HomeworkSubmission[]; error: string } | null>(null);
  const [split, setSplit] = useState(45);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ text: "", tone: "success" as "success" | "error" });
  const [loading, setLoading] = useState(true);

  async function load(submissionId = id) {
    if (!submissionId) return;
    const result = await homeworkApi.submission(submissionId);
    setSubmission(result.submission);
    setItems(result.submission.gradingItems);

  }

  useEffect(() => {
    void fetchMe().then(result => setUser(result.user)).catch(() => setUser(null));
    const frame = requestAnimationFrame(() => {
      const submissionId = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) ?? "");
      setId(submissionId);
      void load(submissionId).catch((error) => setMessage({ text: error instanceof Error ? error.message : "提交记录读取失败", tone: "error" })).finally(() => setLoading(false));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!submission || !["submitted", "processing"].includes(submission.status)) return;
    const timer = setInterval(() => { void load(submission.id).catch(()=>{}); }, 4000);
    return () => clearInterval(timer);
  }, [submission?.id, submission?.status]);

  // A day's latest answers can span the original upload, later additions and corrections. Read their existing evidence on demand.
  useEffect(() => {
    const assigned = submission?.assigned;
    if (!submission || selectedDay == null || !assigned?.days[selectedDay]) return;
    let current = true;
    const from = assigned.days.slice(0, selectedDay).reduce((sum, day) => sum + day.size, 0);
    const questions = assigned.questions.slice(from, from + assigned.days[selectedDay].size);
    const ids = [...new Set(questions.flatMap((question) => question.result ? [question.result.submissionId] : []))];
    void Promise.all(ids.map((id) => id === submission.id ? Promise.resolve(submission) : homeworkApi.submission(id).then((result) => result.submission)))
      .then((uploads) => { if (current) setDayEvidence({ day: selectedDay, submission, uploads: uploads.sort((a, b) => a.version - b.version), error: "" }); })
      .catch((error) => { if (current) setDayEvidence({ day: selectedDay, submission, uploads: [], error: error instanceof Error ? error.message : "当天批改记录读取失败" }); })
      .finally(() => { requestAnimationFrame(() => {
        if (current && scrolledDay.current !== selectedDay) { scrolledDay.current = selectedDay; document.getElementById("day-results")?.scrollIntoView({ block: "start", behavior: "instant" }); }
      }); });
    return () => { current = false; };
  }, [selectedDay, submission]);

  async function repairCoverage(){
    if(!submission)return;setBusy(true);
    try{const result=await homeworkApi.updateSubmission(submission.id,{action:"rebuild-coverage"});setSubmission(result.submission);setItems(result.submission.gradingItems);setMessage({ text: "已开始逐页补全与重批，修复前记录已保留。", tone: "success" });}catch(error){setMessage({ text: error instanceof Error?error.message:"补全失败", tone: "error" });}finally{setBusy(false);}
  }
  async function attachFigures(){
    if(!submission)return;setBusy(true);setMessage({ text: "正在逐页重新校对原卷配图，检查共用题图及手写覆盖，页数多时需要几分钟，请勿关闭本页…", tone: "success" });
    try{const result=await homeworkApi.updateSubmission(submission.id,{action:"attach-figures"});setSubmission(result.submission);setItems(result.submission.gradingItems);const left=result.submission.figuresPending??0;setMessage({ text: left?`仍有 ${left} 道题配图待核对，请检查原卷后再次校对`:"原卷配图已校对，错题本已同步", tone: "error" });}catch(error){setMessage({ text: error instanceof Error?error.message:"配图校对失败", tone: "error" });}finally{setBusy(false);}
  }
  // A new upload: the whole sheet, one day not handed in yet, or one day's mistakes. A failed latest upload gives way once the teacher agrees.
  async function newVersion(scope: { correctionDay?: number; uploadDay?: number }, next: string) {
    if (!submission || !confirmGivingUp(submission.assigned?.uploads.at(-1), next)) return;
    setBusy(true);
    try{const result=await homeworkApi.updateSubmission(submission.id,{action:"new-version",...scope});location.href=`/tools/homework/submissions/${result.submission.id}`;}catch(error){setMessage({ text: error instanceof Error?error.message:"创建上传失败", tone: "error" });setBusy(false);}
  }
  async function changeProfile(profile: boolean) {
    if (!submission || busy || submission.assigned) return;
    const previous = submission.outputs.profile;
    setBusy(true);
    setSubmission({ ...submission, outputs: { ...submission.outputs, profile } });
    try {
      const result = await homeworkApi.updateSubmission(submission.id, { action: "profile", profile });
      setSubmission(result.submission);
      setMessage({ text: profile ? "已计入定档" : "已从定档移出", tone: "success" });
    } catch (error) {
      setSubmission((current) => current && { ...current, outputs: { ...current.outputs, profile: previous } });
      const reason = error instanceof TypeError ? "网络连接中断" : error instanceof Error ? error.message : "定档设置保存失败，请重试";
      setMessage({ text: reason, tone: "error" });
      // A lost response can follow a committed transaction; read the saved flag without replacing an editing draft.
      try {
        const saved = (await homeworkApi.submission(submission.id)).submission;
        setSubmission(saved);
        setMessage({ text: `${reason}；已核对当前状态：${saved.outputs.profile ? "已计入定档" : "未计入定档"}。`, tone: "error" });
      } catch { /* Keep the previous flag and the error. */ }
    } finally { setBusy(false); }
  }
  async function reprocessPending() {
    if (!submission) return;
    setBusy(true); setMessage({ text: "正在补充待处理题目的材料…", tone: "success" });
    try {
      const replacements=[];
      if(supplementPages.length) {
        if(supplementPages.length!==1 || !supplementPageId) throw new Error("请选择要替换的原页，每次补充一页");
        const asset=await uploadHomeworkAsset({blob:supplementPages[0].blob,fileName:"补充页面.jpg",role:"submission_original",submissionId:submission.id});
        replacements.push({replacePageId:supplementPageId,assetId:asset.id});
      }
      await uploadReferences();
      const result=await homeworkApi.updateSubmission(submission.id,{action:"reprocess-pending",pages:replacements});
      releaseHomeworkPages(supplementPages);setSubmission(result.submission);setItems(result.submission.gradingItems);setSupplementPages([]);setMessage({ text: "已重新处理待处理题，原始页面仍保留在历史原件中", tone: "success" });
    } catch(error){setMessage({ text: error instanceof Error?error.message:"重新处理失败", tone: "error" });}finally{setBusy(false);}
  }

  // Reference answer pages are appended to the homework in the order they are chosen.
  async function uploadReferences() {
    if (!submission || !referenceFiles.length) return;
    const {readStudioFiles}=await import("../../../../../lib/answer-studio-images");
    for(const file of referenceFiles){
      const blobs=file.type.startsWith("image/")?[file]:await Promise.all((await readStudioFiles([file],"answer","",()=>{})).map(async page=>(await fetch(page.image)).blob()));
      for(const blob of blobs)await uploadHomeworkAsset({blob,fileName:file.name,role:"answer",assignmentId:submission.assignmentId});
    }
    setReferenceFiles([]);
  }

  async function uploadAndSubmit() {
    if (!submission || !pages.length) return;
    setBusy(true);
    setMessage({ text: "正在上传作业原件…", tone: "success" });
    try {
      for (const file of sourceDocuments) await uploadHomeworkAsset({blob:file,fileName:file.name,role:"submission_document",submissionId:submission.id});
      setSourceDocuments([]);
      const saved = [];
      for (const [index, page] of pages.entries()) {
        const asset = await uploadHomeworkAsset({ blob: page.blob, fileName: `${submission.studentName}-第${index + 1}页.jpg`, role: "submission_original", submissionId: submission.id });
        saved.push({ assetId: asset.id });
        setMessage({ text: `正在上传第 ${index + 1}/${pages.length} 页…`, tone: "success" });
      }
      await uploadReferences();
      await homeworkApi.updateSubmission(submission.id, { action: "save-pages", pages: saved });
      const result = await homeworkApi.updateSubmission(submission.id, { action: "submit" });
      releaseHomeworkPages(pages); setPages([]);
      setSubmission(result.submission);
      setItems(result.submission.gradingItems);
      setMessage({ text: "作业已提交，后台会自动批改并发布结果", tone: "success" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "作业提交失败", tone: "error" });
    } finally { setBusy(false); }
  }

  function focusEvidence(item: GradingItem, openDetail = false) {
    setActiveItemId(item.id);
    const card = document.getElementById(`grading-${item.id}`) as HTMLDetailsElement | null;
    if (openDetail && card) card.open = true;
    requestAnimationFrame(() => {
      if (window.matchMedia("(min-width:1001px)").matches) card?.closest(".review-evidence-layout")?.scrollIntoView({ block: "start", behavior: "instant" });
      const marker = document.getElementById(`marker-${item.id}`);
      const page = document.getElementById(`page-${item.pageId}`);
      for (const target of [marker ?? page, card]) {
        const pane = target?.closest<HTMLElement>(".review-pages,.grading-list");
        if (pane && target) pane.scrollTo({ top: pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12, behavior: "instant" });
      }
    });
  }

  function updateItem(itemId: string, patch: Partial<GradingItem>) {
    setItems((current) => current.map((item) => item.id === itemId ? { ...item, ...patch } : item));
  }

  async function saveCorrection(item: GradingItem) {
    if (!submission) return;
    setBusy(true);
    try {
      const result = await homeworkApi.updateSubmission(submission.id, { action: "correct", items: [{
        id: item.id, verdict: item.verdict, score: item.score, maxScore: item.maxScore, standardAnswer:item.standardAnswer, standardAnalysis:item.standardAnalysis, referenceVerified:item.referenceVerified, stem:item.stem, studentAnswer: item.studentAnswer, feedback: item.feedback,
        errorType: item.errorType, stepAnalysis: item.stepAnalysis, evidenceSummary: item.evidenceSummary,
        capabilityKeys: item.capabilityKeys, confidence: item.confidence,
      }] });
      setSubmission(result.submission);
      setItems(result.submission.gradingItems);
      setEditingId("");
      await load(submission.id);
      setMessage({ text: "判定已修正，错题本和作业报告已同步更新", tone: "success" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "修正失败", tone: "error" });
    } finally { setBusy(false); }
  }

  async function finishLegacySubmission() {
    if (!submission) return;
    setBusy(true);
    try {
      let result = submission;
      if (submission.status === "review_required") {
        result = (await homeworkApi.updateSubmission(submission.id, { action: "review", items: items.map((item) => ({
          id: item.id, verdict: item.verdict === "review_required" ? "incorrect" : item.verdict,
          studentAnswer: item.studentAnswer, feedback: item.feedback, errorType: item.errorType, confidence: item.confidence,
        })) })).submission;
      }
      if (result.status === "ready") result = (await homeworkApi.updateSubmission(submission.id, { action: "publish" })).submission;
      setSubmission(result);
      setItems(result.gradingItems);
      await load(submission.id);
      setMessage({ text: "旧提交结果已发布", tone: "success" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "旧提交处理失败", tone: "error" });
    } finally { setBusy(false); }
  }

  async function retry() {
    if (!submission) return;
    setBusy(true);
    try {
      const result = await homeworkApi.updateSubmission(submission.id, { action: "retry" });
      setSubmission(result.submission);
      setMessage({ text: "已重新提交后台批改任务", tone: "success" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "重试失败", tone: "error" });
    } finally { setBusy(false); }
  }

  async function cancelGrading() {
    if (!submission || !confirm(submission.status === "failed" ? "放弃这次上传，回到待上传？传过的页面会清除，之后重新选页面提交。"
      : "停止这次批改，回到待上传？已经批改的结果和传过的页面都会清除，之后重新选页面提交。")) return;
    setBusy(true);
    try {
      const result = await homeworkApi.updateSubmission(submission.id, { action: "cancel" });
      setSubmission(result.submission); setItems(result.submission.gradingItems);
      setMessage({ text: "已回到待上传，请重新选页面提交", tone: "success" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "停止批改失败", tone: "error" });
    } finally { setBusy(false); }
  }

  // The report is typeset on this computer; where no typesetter runs, the TeX source is still available.
  async function downloadReport(kind: "pdf" | "tex") {
    if (!submission?.report?.details) return;
    setBusy(true);
    try {
      const { buildHomeworkReportLatex, HOMEWORK_REPORT_MAIN } = await import("../../../../../lib/homework-report-latex");
      const tex = buildHomeworkReportLatex(submission);
      const name = `${submission.studentName}-${submission.assignmentTitle}-批改报告`;
      if (kind === "tex") { saveBlob(new Blob([tex], { type: "application/x-tex" }), `${name}.tex`); setMessage({ text: "TeX 源文件已下载", tone: "success" }); return; }
      const { compileLatexPdf, latexCompilerStatus } = await import("../../../../../lib/handout-latex-files");
      if (!(await latexCompilerStatus()).available) { setMessage({ text: "这台设备无法排版 PDF，请下载 TeX 源文件，或在运行 MathPilot 的电脑上打开本页", tone: "error" }); return; }
      const { pdf, issues } = await compileLatexPdf({ main: HOMEWORK_REPORT_MAIN, files: { [HOMEWORK_REPORT_MAIN]: new TextEncoder().encode(tex) }, missingFigures: 0 });
      saveBlob(pdf, `${name}.pdf`);
      setMessage({ text: issues ? `报告 PDF 已生成，${issues} 处公式需要检查` : "报告 PDF 已生成", tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "报告生成失败", tone: "error" }); }
    finally { setBusy(false); }
  }

  async function exportMistakes(questions: Question[], kind: "word" | "pdf") {
    if (!submission || busy || !questions.length) return;
    const format = kind === "word" ? "Word" : "PDF";
    setBusy(true); setMessage({ text: `正在导出当前错题 ${format}…`, tone: "success" });
    try {
      const title = `${submission.studentName}-${titleWithoutStudent(submission.assignmentTitle, submission.studentName)}-当前错题`;
      let issues = 0;
      if (kind === "word") {
        const { buildQuestionsWordBlob, downloadWordBlob } = await import("../../../../../lib/export-word");
        downloadWordBlob(await buildQuestionsWordBlob(questions, title, false, "basket"), `${title}.docx`);
      } else {
        const { buildHandoutLatexProject, compileLatexPdf, latexCompilerStatus } = await import("../../../../../lib/handout-latex-files");
        if (!(await latexCompilerStatus()).available) throw new Error("当前服务无法生成 PDF，请使用本地 MathPilot 导出。");
        const project = await buildHandoutLatexProject({ title, sheet: "错题练习", questions, answers: "none" });
        if (project.missingFigures) throw new Error(`${project.missingFigures} 张配图读取失败，请重试导出`);
        const result = await compileLatexPdf(project);
        issues = result.issues;
        saveBlob(result.pdf, `${title}.pdf`);
      }
      setMessage({ text: `已导出 ${questions.length} 道当前错题（${format}，不含答案）${issues ? `，${issues} 处公式需要检查` : ""}`, tone: issues ? "error" : "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "错题导出失败，请重试", tone: "error" }); }
    finally { setBusy(false); }
  }

  async function refresh() {
    setBusy(true);
    try { await load(); setMessage({ text: "状态已刷新", tone: "success" }); }
    finally { setBusy(false); }
  }

  if (loading) return <><SiteHeader active="students" user={user ?? null} loading={user === undefined} trail={[{label:"学生档案",href:"/?view=wrong-book"},{label:"批改详情"}]} /><main className="homework-loading">正在读取学生作业…</main></>;
  if (!submission) return <><SiteHeader active="students" user={user ?? null} loading={user === undefined} trail={[{label:"学生档案",href:"/?view=wrong-book"},{label:"批改详情"}]} /><main className="homework-loading"><p>{message.text || "提交记录不存在"}</p><a href="/tools/homework">返回作业批改</a></main></>;

  const report = submission.report;
  const live = ["submitted", "processing", "failed"].includes(submission.status);
  const summary = submission.gradingSummary;
  const marks = summary?.marks;
  const international = submission.curriculum === "international";
  const binary = Boolean(submission.assigned) && !international;
  const coverage = submission.pageCoverage;
  const incomplete = !!coverage && coverage.processed < coverage.total;
  const pendingPages = coverage?.pages.filter(page=>page.kind === "unreadable") ?? [];
  const pending = items.filter(isPendingGradingItem);
  const issues = items.filter((item) => !isPendingGradingItem(item) && (item.verdict === "partial" || item.verdict === "incorrect")).length;
  const outputs = OUTPUT_LABELS.filter(([key])=>submission.outputs[key]).map(([,label])=>label);
  const status = incomplete && submission.status === "published" ? "结果不完整" : submission.status === "published" && !binary && coverage?.unreadable ? "有页面待补图" : STATUS[submission.status] ?? submission.status;

  const assigned = submission.assigned;
  const dayTask = selectedDay == null ? undefined : assigned?.days[selectedDay];
  const dayStart = assigned?.days.slice(0, selectedDay ?? 0).reduce((sum, day) => sum + day.size, 0) ?? 0;
  const dayQuestions = dayTask ? assigned!.questions.slice(dayStart, dayStart + dayTask.size) : [];
  const evidence = dayEvidence?.day === selectedDay && dayEvidence.submission === submission ? dayEvidence : null;
  const evidenceItems = dayTask ? dayQuestions.flatMap((question) => {
    const item = evidence?.uploads.find((upload) => upload.id === question.result?.submissionId)?.gradingItems.find((item) => item.assignmentQuestionId === question.id);
    return item ? [item] : [];
  }) : items;
  const evidencePages = dayTask ? evidence?.uploads.flatMap((upload) => upload.pages.filter((page) => evidenceItems.some((item) => item.pageId === page.id))) ?? [] : submission.pages;
  const scoped = assigned?.questions.filter((question) => submission.questionScope?.includes(question.id)) ?? [];
  // A scope of questions already handed in is a correction; one of questions not yet handed in is one 打卡 day's upload.
  const correctionQuestions = scoped.every((question) => question.result) ? scoped : [];
  let dayEnd = 0;
  const uploadDay = !correctionQuestions.length && scoped.length ? assigned!.days.find((entry) => (dayEnd += entry.size) > assigned!.questions.indexOf(scoped[0])) : undefined;
  const archiveLink = `/?view=wrong-book&studentId=${encodeURIComponent(submission.studentId)}`;
  return <><SiteHeader active="students" user={user ?? null} loading={user === undefined}
    trail={[{label:"学生档案",href:"/?view=wrong-book"},{label:submission.studentName,href:`${archiveLink}&tab=homework`},{label:titleWithoutStudent(submission.assignmentTitle, submission.studentName)}]}
    trailActions={<>{submission.outputs.report && international && report?.details && <button className="secondary" disabled={busy} onClick={() => downloadReport("pdf")}>下载批改报告</button>}<PaperMoreMenu label="作业维护操作"><button disabled={busy} onClick={refresh}>刷新</button>{!assigned && ["published","ready"].includes(submission.status) && <button onClick={attachFigures} disabled={busy}>校对原卷配图{submission.figuresPending ? `（${submission.figuresPending}题待核对）` : ""}</button>}{submission.status === "published" && !assigned && <button disabled={busy} onClick={() => void newVersion({}, "上传新版本")}>上传新版本</button>}{submission.outputs.report && international && report?.details && <button disabled={busy} onClick={() => downloadReport("tex")}>下载 TeX</button>}</PaperMoreMenu></>} /><main className="review-shell">
    {message.text && <div className={`homework-notice${message.tone === "error" ? " inline-error" : ""}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}<button onClick={() => setMessage({ text: "", tone: "success" })} aria-label="关闭提示">×</button></div>}
    <section className="review-summary"><div><span className={`review-status ${submission.status}`}>{status}</span><h1>{titleWithoutStudent(submission.assignmentTitle, submission.studentName)}</h1><p>{[submission.studentName, assigned ? `第 ${submission.version} 次上传` : `第 ${submission.version} 版`, ...(submission.status === "draft" ? [] : [`${submission.pages.length} 页`, ...(live ? [] : [`${items.length} 道题`, ...(items.length ? [`${issues} 处需要改进`] : [])])]), outputs.length ? outputs.join("、") : "仅批改，不写入学生档案"].join(" · ")}</p></div>
      {!live && marks && <div className="review-score" aria-label="得分"><b>{marks.score}</b><span>/ {marks.maxScore}</span><small>{marks.percentage == null ? `${marks.pending} 题待定分` : `${marks.percentage}%`}</small></div>}
      <div className="review-outputs" role="group" aria-label="这份作业写到了哪里">
        {submission.outputs.wrongBook && <div><span>写入错题本</span><a href={archiveLink}>已归档错题 {summary?.archived ?? 0} 道 →</a></div>}
        <label><input type="checkbox" role="switch" aria-label="计入定档" checked={submission.outputs.profile} disabled={busy || Boolean(assigned) || live || submission.status === "ready"}
          aria-describedby={assigned ? "profile-inclusion-note" : undefined} onChange={(event) => void changeProfile(event.target.checked)} /><span>计入定档</span></label>
        {assigned ? <small id="profile-inclusion-note">布置的作业总是计入</small> : (live || submission.status === "ready") && <small>批改发布完成后可以切换</small>}
      </div></section>

    {assigned && <AssignedHomeworkSheet submission={{ ...submission, assigned }} busy={busy} selectedDay={selectedDay} onExport={(questions, kind) => void exportMistakes(questions, kind)}
      onDay={(day) => { setSelectedDay(day); setEditingId(""); setActiveItemId(""); requestAnimationFrame(() => document.getElementById("day-results")?.scrollIntoView({ block: "start", behavior: "instant" })); }}
      onContinue={() => void newVersion({}, "继续上传这份作业")}
      onCorrect={(day) => void newVersion({ correctionDay: day }, assigned.days.length > 1 ? `订正第 ${day + 1} 天的错题` : "订正错题")}
      onUpload={(day) => void newVersion({ uploadDay: day }, `上传第 ${day + 1} 天的作业`)}
      onFocus={(questionId) => {
        const item = evidenceItems.find((entry) => entry.assignmentQuestionId === questionId) ?? items.find((entry) => entry.assignmentQuestionId === questionId);
        if (!item) return;
        if (!evidenceItems.includes(item)) { setSelectedDay(null); requestAnimationFrame(() => focusEvidence(item, true)); }
        else focusEvidence(item, true);
      }} />}
    {dayTask && <section className="assigned-sheet" id="day-results" aria-label="当天提交与批改">
      <header><div><h2>{dayTask.title || `第 ${selectedDay! + 1} 天`} · 提交与批改</h2><p>{dayNote(dayTask)} · 共 {dayTask.size} 道题</p></div>
        <button type="button" onClick={() => { setSelectedDay(null); setActiveItemId(""); }}>返回第 {submission.version} 次上传</button></header>
      <VerdictTally items={dayQuestions.map((question) => question.result)} total={dayTask.size} international={international} />
      {!evidence ? <p role="status">正在读取这一天的原卷与批改记录…</p> : evidence.error ? <p className="inline-error" role="alert">{evidence.error} <button type="button" disabled={busy} onClick={refresh}>重试</button></p>
        : !dayTask.done ? <p>这一天还未提交，暂无原卷和批改记录。</p>
        : <nav className="assigned-uploads" aria-label="当天批改来源">{assigned!.uploads.filter((upload) => evidence.uploads.some((source) => source.id === upload.id)).map((upload) => <a key={upload.id} href={`/tools/homework/submissions/${encodeURIComponent(upload.id)}`}>第 {upload.version} 次上传 · {uploadNote(upload)} · 查看原卷与批改</a>)}</nav>}
    </section>}
    {!dayTask && live && <LiveBoard submission={submission} international={international} busy={busy} onRetry={incomplete ? repairCoverage : retry} onCancel={cancelGrading} />}
    {!dayTask && !live && coverage && (incomplete || (!binary && coverage.unreadable > 0)) && <section className="review-callout" aria-label="作业页面完整性"><div><b>{incomplete ? `${coverage.missing.length} 页未读取，当前结果不能代表整份作业` : `${coverage.unreadable} 页需要补图核实`}</b>{pageFailures(coverage).map((line) => <p key={line}>{line}</p>)}<ol className="page-chips" aria-label="逐页状态">{coverage.pages.map((page) => { const state = pageState(page, false); return <li key={page.pageNumber} className={state} title={`第 ${page.pageNumber} 页 · ${PAGE_LABEL[state]}`}>{page.pageNumber}</li>; })}</ol></div>{incomplete && ["published", "ready"].includes(submission.status) && <button className="primary" onClick={repairCoverage} disabled={busy}>补全页面并重新批改</button>}</section>}
    {/* An assigned question keeps the figures it was handed out with; only questions read off the page have figures to check. */}
    {!dayTask && summary && !live && !!items.length && <section className="review-ledger" aria-label="批改结果统计"><VerdictTally items={assigned ? assigned.questions.map((question) => question.result) : items} total={assigned ? assigned.questions.length : items.length} international={international} /></section>}
    {!dayTask && !binary && submission.status === "published" && (pending.length>0 || pendingPages.length>0) && <details className="homework-panel pending-homework"><summary>{pending.length} 道题{pendingPages.length ? `、${pendingPages.length} 页` : ""}待处理 · 补充材料或修正判定</summary><p>看不清或判定待复核。补图或确认判定之后，才会计入错题本和定档。</p>{pending.length > 0 && <div className="student-panel-actions" role="list" aria-label="待处理题目">{pending.map((item) => <div role="listitem" key={item.id}><button type="button" onClick={() => focusEvidence(item, true)}>{homeworkQuestionLabel(item.questionNumber)}</button></div>)}</div>}<label>补图对应原页<select value={supplementPageId} disabled={busy} onChange={e=>setSupplementPageId(e.target.value)}><option value="">选择原页</option>{submission.pages.map((page,index)=><option key={page.id} value={page.id}>第 {index+1} 页</option>)}</select></label><HomeworkPagePicker pages={supplementPages} onChange={setSupplementPages} disabled={busy} limit={1} label="粘贴或拖入补充的一页" /><label>补充参考答案（选填）<input type="file" aria-label="待处理题参考答案" multiple accept="image/*,application/pdf" disabled={busy} onChange={e=>setReferenceFiles([...(e.target.files??[])])} /></label><button className="primary" onClick={reprocessPending} disabled={busy || (supplementPages.length>0 && (!supplementPageId || supplementPages.length!==1))}>{busy?"正在处理…":"重新处理待处理题"}</button><p>也可以在下方对应题目中补充参考答案并修正判定。</p></details>}


    {!dayTask && submission.status === "draft" && <section className="review-upload"><div><h2>{correctionQuestions.length ? "上传错题订正" : scoped.length ? `上传${uploadDay?.title || "这一天"}的作业` : "上传学生作业"}</h2><p>{correctionQuestions.length ? `本次订正：${correctionQuestions.map((question) => homeworkQuestionLabel(question.number)).join("、")}。上传订正照片或 PDF，只更新本次找到的错题，其他题保留原状态。` : scoped.length ? `本次只批改这一天还没交的 ${scoped.length} 道题：${scoped.map((question) => homeworkQuestionLabel(question.number)).join("、")}。` : assigned ? "学生拍好的照片或 PDF，可以只传交来的部分，按这份作业的题目清单批改，没交的题之后再传。" : "看不清的题目单独待处理，其余正常批改。"}</p></div><HomeworkPagePicker pages={pages} onChange={setPages} disabled={busy} onSourceFile={file=>setSourceDocuments(current=>[...current,file])} />{!assigned && <details className="completed-reference"><summary>参考答案（选填）</summary><input aria-label="补充参考答案" type="file" multiple accept="image/*,application/pdf" onChange={e=>setReferenceFiles([...(e.target.files??[])])} /></details>}<button className="primary upload-submit" disabled={busy || !pages.length} onClick={uploadAndSubmit}>{busy ? "正在上传…" : `提交 ${pages.length} 页${correctionQuestions.length ? "订正" : "作业"}`}</button></section>}


    {!dayTask && ["review_required", "ready"].includes(submission.status) && <section className="legacy-result-banner"><div><b>这是启用自动发布前产生的旧提交</b><p>保留旧流程兼容，不会被后台自动发布。</p></div><button className="primary" onClick={finishLegacySubmission} disabled={busy}>确认并发布</button></section>}

    {(dayTask || ["review_required", "ready", "published"].includes(submission.status)) && <>
      {!dayTask && submission.outputs.report && international && report?.details && <section className="diagnosis-grid"><InternationalReportCard report={report.details} /></section>}
      {!dayTask && submission.outputs.report && !international && <section className="diagnosis-grid">
        <article className="submission-report-card"><header><span>整份诊断</span><h2>{report?.overallSummary || "逐题结果已完成"}</h2><p>{report?.studentMessage || "当前提交尚未生成整份建议。"}</p></header>{report && <><div className="report-columns"><section><b>做得好的地方</b>{report.strengths.length ? report.strengths.map((point) => <div key={`${point.title}-${point.questionNumbers.join("-")}`}><strong>{point.title}</strong><p>{point.detail}</p><small>{point.questionNumbers.map(homeworkQuestionLabel).join("、")}</small></div>) : <p className="report-empty">本次暂无足够证据。</p>}</section><section><b>优先改进</b>{report.gaps.length ? report.gaps.map((point) => <div key={`${point.title}-${point.questionNumbers.join("-")}`}><strong>{point.title}</strong><p>{point.detail}</p><small>{point.questionNumbers.map(homeworkQuestionLabel).join("、")}</small></div>) : <p className="report-empty">暂未发现优先问题。</p>}</section></div><section className="report-actions"><b>下一步建议</b><ol>{report.actions.map((action) => <li key={action}>{action}</li>)}</ol></section></>}</article>
      </section>}

      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll this region independently. */}
      {!!evidencePages.length && <section className="review-evidence-layout" style={{ "--review-split": `${split}%` } as CSSProperties}><div className="review-pages" id="review-originals" role="region" aria-label="原卷标记，独立滚动" tabIndex={0}><h2>原卷标记</h2>{evidencePages.map((page) => <figure id={`page-${page.id}`} key={page.id}><div className="graded-page"><img src={page.processedUrl} alt={`${submission.studentName}答卷${dayTask ? `第 ${assigned!.uploads.find((upload) => upload.id === page.submissionId)?.version} 次上传 · ` : ""}第 ${page.pageOrder + 1} 页`} />{evidenceItems.filter((item) => item.pageId === page.id && item.bbox).map((item) => <button id={`marker-${item.id}`} key={item.id} className={`grade-marker ${!international && item.verdict === "partial" ? "incorrect" : item.verdict}`} aria-pressed={activeItemId === item.id} style={{ left: `${item.bbox!.x / 10}%`, top: `${item.bbox!.y / 10}%`, width: `${item.bbox!.width / 10}%`, height: `${item.bbox!.height / 10}%` }} onClick={() => focusEvidence(item, true)} aria-label={`查看${homeworkQuestionLabel(item.questionNumber)}`}>{item.verdict === "correct" ? "✓" : item.verdict === "partial" ? international ? "△" : "×" : item.verdict === "incorrect" ? "×" : "?"}</button>)}</div><figcaption>{dayTask && `第 ${assigned!.uploads.find((upload) => upload.id === page.submissionId)?.version} 次上传 · `}第 {page.pageOrder + 1} 页</figcaption></figure>)}</div>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- A focusable ARIA window splitter supports pointer and keyboard resizing. */}
        <div className="review-splitter" role="separator" aria-label="调整原卷与详情宽度" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={70} aria-valuenow={split} aria-controls="review-originals review-details" tabIndex={0}
          onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = event.currentTarget.parentElement!.getBoundingClientRect(); setSplit(Math.max(30, Math.min(70, Math.round((event.clientX - box.left) / box.width * 100)))); }}
          onPointerUp={event => { if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId); }}
          onDoubleClick={() => setSplit(45)}
          onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); setSplit(current => event.key === "Home" ? 30 : event.key === "End" ? 70 : Math.max(30, Math.min(70, current + (event.key === "ArrowLeft" ? -2 : 2)))); }} />
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll this region independently. */}
        <div className="grading-list" id="review-details" role="region" aria-label="逐题详情，独立滚动" tabIndex={0}><div className="grading-heading"><div><h2>逐题证据</h2><p>展开题目查看学生作答、参考答案和判定依据。</p></div></div>{evidenceItems.map((item) => {
          const editing = editingId === item.id;
          return <details id={`grading-${item.id}`} key={item.id} className={`grading-card compact ${!international && item.verdict === "partial" ? "incorrect" : item.verdict}${activeItemId === item.id ? " selected" : ""}`} onToggle={event => { if (event.currentTarget.open) focusEvidence(item); }} open={editing || undefined}><summary><span>{homeworkQuestionLabel(item.questionNumber)}</span><b>{verdictLabel(item, international)}</b>{dayTask && <small>第 {assigned!.uploads.find((upload) => upload.id === item.submissionId)?.version} 次上传</small>}{item.teacherMark && <small>老师批改</small>}</summary><div className="grading-detail">{international && <p className="grading-stem"><MathText text={item.stem} /></p>}{international && !!item.figures?.length && <div className="grading-figures">{item.figures.map((figure, index) => <img key={figure.url} className={figure.kind} src={figure.url} alt={`${homeworkQuestionLabel(item.questionNumber)}配图 ${index + 1}`} loading="lazy" />)}</div>}{editing ? <><div className="grading-fields"><label>批改结论<select value={item.verdict} onChange={(event) => updateItem(item.id, reconcileHomeworkScore(event.target.value as GradingItem["verdict"], null, item.maxScore, submission.curriculum))}><option value="correct">正确</option><option value="incorrect">错误</option>{!binary && <><option value="partial">部分正确</option><option value="unreadable">{international ? "看不清（0 分）" : "待补图"}</option><option value="review_required">待核实</option></>}</select></label><label>错误类型<input value={item.errorType} onChange={(event) => updateItem(item.id, { errorType: event.target.value })} placeholder="计算、审题、步骤…" /></label>{!binary && <label>满分<input type="number" min={0} step={0.5} inputMode="decimal" value={item.maxScore ?? ""} onChange={(event) => { const maxScore = event.target.value === "" ? null : Number(event.target.value); updateItem(item.id, { maxScore, ...reconcileHomeworkScore(item.verdict, item.score, maxScore, submission.curriculum) }); }} placeholder="原卷无分值可留空" /></label>}{!binary && item.maxScore != null && <label>得分<input type="number" min={0} max={item.maxScore} step={0.5} inputMode="decimal" value={item.score ?? ""} onChange={(event) => updateItem(item.id, event.target.value === "" ? { score: null } : reconcileHomeworkScore("partial", event.target.value, item.maxScore))} /></label>}</div><label>题干<textarea rows={3} value={item.stem} onChange={event=>updateItem(item.id,{stem:event.target.value})} /></label><label>参考答案<input value={item.standardAnswer} onChange={event=>updateItem(item.id,{standardAnswer:event.target.value})} /></label><label>参考解析<textarea rows={3} value={item.standardAnalysis} onChange={event=>updateItem(item.id,{standardAnalysis:event.target.value})} /></label><label><input type="checkbox" checked={item.referenceVerified === true} onChange={event=>updateItem(item.id,{referenceVerified:event.target.checked})} />我已核实题目与参考解答</label><label>学生作答<textarea rows={2} value={item.studentAnswer} onChange={(event) => updateItem(item.id, { studentAnswer: event.target.value })} /></label><label>给学生的反馈<textarea rows={3} value={item.feedback} onChange={(event) => updateItem(item.id, { feedback: event.target.value })} /></label><div className="correction-actions"><button onClick={() => { setEditingId(""); void load(submission.id); }}>取消</button><button className="primary" onClick={() => saveCorrection(item)} disabled={busy}>保存修正</button></div></> : <>{international && item.stepAnalysis.length > 0 && <div className="step-analysis"><b>步骤分析</b><ol>{item.stepAnalysis.map((step) => <li key={step}>{step}</li>)}</ol></div>}{item.standardAnswer && <div className="standard-answer"><b>参考答案 · {item.referenceSource === "agent" ? "独立解题" : item.referenceSource === "unresolved" ? "待校验" : item.referenceEvidence === "题库原题答案" ? "题库答案" : item.referenceEvidence === "布置时资料自带的答案" ? "资料自带答案" : "教师提供"}</b><p><MathText text={item.standardAnswer} /></p>{item.standardAnalysis && <small><MathText text={item.standardAnalysis} /></small>}</div>}{international && (item.evidenceSummary || item.feedback || item.errorType) && <div className="evidence-feedback"><b>判定依据与反馈</b><p>{[item.evidenceSummary, item.feedback].filter(Boolean).join("。")}</p>{item.errorType && <small>问题标签：{item.errorType}</small>}</div>}{!item.standardAnswer && <p className="reference-empty">{item.teacherMark === "correct" ? "老师已判为正确，无需补充参考答案。" : item.referenceEvidence || item.feedback || "参考答案待补全，可在上方待处理区重新处理。"}</p>}{(dayTask || submission.status === "published") && <button className="quiet-correction" onClick={() => dayTask ? location.assign(`/tools/homework/submissions/${encodeURIComponent(item.submissionId)}#grading-${item.id}`) : setEditingId(item.id)}>{dayTask ? "去原上传修正判定" : "修正判定"}</button>}</>}</div></details>;
        })}</div>
      </section>}
    </>}
    {!dayTask && !!submission.questionOriginals?.length && <details className="homework-panel review-archive-panel"><summary>学校作业原件（{submission.questionOriginals.length} 页）</summary><div className="original-files">{submission.questionOriginals.map((document,index)=><a key={document.url} className="original-file" href={document.url} target="_blank" rel="noreferrer"><img src={document.url} alt=""/><span><b>{document.name}</b><small>第 {index+1} 页 · 点击在新窗口打开</small></span></a>)}</div></details>}
    {!dayTask && !!submission.originalDocuments?.length && <details className="homework-panel review-archive-panel"><summary>上传的 PDF 原件</summary><div className="original-files">{submission.originalDocuments.map((document,index)=><a key={index} className="original-file" href={document.url} target="_blank" rel="noreferrer"><svg className="pdf-icon" viewBox="0 0 32 40" aria-hidden="true" focusable="false"><path d="M7 1.5h13.5l9 9v24a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-29a4 4 0 0 1 4-4Z" /><path d="M20.5 1.5v6a3 3 0 0 0 3 3h6" /><rect x="0" y="20" width="23" height="11" rx="2.5" /><text x="11.5" y="28.3">PDF</text></svg><span><b>{document.name}</b><small>学生上传的原件 · 点击在新窗口打开</small></span><svg className="open-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 17 17 7M9 7h8v8" /></svg></a>)}</div></details>}
    {!dayTask && !!submission.pageRevisions?.length && <details className="homework-panel review-archive-panel"><summary>历史作业原件</summary>{submission.pageRevisions.map((revision,index)=><p key={index}><a href={revision.originalUrl} target="_blank" rel="noreferrer">补图前原件 · {new Date(revision.createdAt).toLocaleString("zh-CN")}</a></p>)}</details>}
  </main></>;
}
