"use client";

import { useEffect, useState, type CSSProperties } from "react";
import HomeworkPagePicker, { releaseHomeworkPages, type HomeworkPage } from "../../../../components/HomeworkPagePicker";
import { MathText } from "../../../../components/MathText";
import { homeworkApi, uploadHomeworkAsset } from "../../../../../lib/homework-api-client";
import { homeworkQuestionLabel, reconcileHomeworkScore } from "../../../../../lib/homework-grading-rules.mjs";
import type { GradingItem, HomeworkSubmission, InternationalReport } from "../../../../../lib/types";

const STATUS: Record<string, string> = {
  draft: "待上传", submitted: "已提交", processing: "自动批改中", review_required: "旧版待复核",
  ready: "旧版待发布", published: "结果已发布", failed: "处理失败",
};
const OUTPUT_LABELS = [["wrongBook", "写入错题本"], ["report", "生成错题报告"], ["profile", "整合到学生画像"]] as const;
const VERDICT: Record<string, string> = { correct: "正确", partial: "部分正确", incorrect: "错误", unreadable: "待补图", review_required: "待核实" };
function verdictLabel(item: GradingItem, international: boolean) {
  const label = international && item.verdict === "unreadable" ? "看不清" : VERDICT[item.verdict] ?? item.verdict;
  return item.maxScore != null && item.score != null ? `${label} · ${item.score}/${item.maxScore} 分` : label;
}
type Bucket = "correct" | "partial" | "incorrect" | "pending";
const BUCKETS: Array<[Bucket, string]> = [["correct", "正确"], ["partial", "部分正确"], ["incorrect", "错误"], ["pending", "待处理"]];
// Matches the server summary: anything still awaiting review counts as pending, whatever its verdict.
function bucket(item: GradingItem): Bucket {
  return item.requiresReview || item.verdict === "unreadable" || item.verdict === "review_required" ? "pending" : item.verdict;
}
type Coverage = NonNullable<HomeworkSubmission["pageCoverage"]>;
type PageInfo = Coverage["pages"][number];
const PAGE_LABEL: Record<string, string> = { read: "已读取", blank: "空白页", unreadable: "待补图", waiting: "待读取", retrying: "重试中", error: "未完成" };
function pageState(info: PageInfo | undefined, live: boolean) {
  if (info?.valid) return info.kind === "blank" ? "blank" : info.kind === "unreadable" ? "unreadable" : "read";
  return info?.reason ? live ? "retrying" : "error" : "waiting";
}
// Failed pages usually share one cause; one line per cause reads better than one line per page.
function pageFailures(coverage: Coverage) {
  const causes = new Map<string, number[]>();
  for (const page of coverage.pages) if (!page.valid && page.reason) causes.set(page.reason, [...causes.get(page.reason) ?? [], page.pageNumber]);
  return [...causes].map(([reason, pages]) => `第 ${pages.join("、")} 页：${reason}`);
}

/** One bar for the whole paper: graded questions fill it by verdict, the rest stays empty until graded. */
function VerdictTally({ items, total }: { items: GradingItem[]; total: number }) {
  const counts: Record<Bucket, number> = { correct: 0, partial: 0, incorrect: 0, pending: 0 };
  for (const item of items) counts[bucket(item)]++;
  const scale = Math.max(total, items.length, 1);
  return <div className="verdict-tally">
    <div className="tally-bar" role="img" aria-label={`${scale} 道题中已批改 ${items.length} 道`}>{BUCKETS.map(([key]) => counts[key] > 0 && <i key={key} className={key} style={{ width: `${counts[key] / scale * 100}%` }} />)}</div>
    <dl>{BUCKETS.map(([key, label]) => <div key={key} className={key}><dt>{label}</dt><dd>{counts[key]}</dd></div>)}</dl>
  </div>;
}

const STAGES = ["读取页面", "识别题目", "准备参考答案", "逐题批改"];
/** While grading runs: the four pipeline stages, every page as it is read, and each verdict as soon as it is saved. */
function LiveBoard({ submission, international, busy, onRetry }: { submission: HomeworkSubmission; international: boolean; busy: boolean; onRetry(): void }) {
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
  const failures = coverage ? pageFailures(coverage) : [];
  return <section className={`live-board${failed ? " failed" : retrying ? " retrying" : ""}`} aria-label="批改进度">
    <header><div><h2>{failed ? "自动批改遇到问题" : current === 2 && graded > 0 ? "正在准备参考答案并批改" : `正在${STAGES[current]}`}</h2><p role="status">{failed ? submission.failureReason || "已完成的部分已保存，可以重新批改。" : retrying ? `${submission.failureReason}。已完成的部分会保留，无需操作。` : "可以离开本页，结果完成后会自动保存。"}</p></div>{failed && <button className="primary" onClick={onRetry} disabled={busy}>{read < total ? "补全页面并重新批改" : "重新批改"}</button>}</header>
    <ol className="live-stages">{STAGES.map((label, index) => {
      const [value, max] = stages[index], state = index < current ? "done" : index > current && !(index === 3 && graded > 0) ? "waiting" : failed ? "stalled" : "active";
      const fill = max ? Math.min(1, value / max) : index < current ? 1 : 0;
      return <li key={label} className={state}><span>{label}</span><b>{state === "waiting" && !value ? "—" : <>{value}<small>{max == null ? " 道" : ` / ${max}`}</small></>}</b><i><em style={{ width: `${fill * 100}%` }} /></i></li>;
    })}</ol>
    <div className="live-body">
      <div className="page-map">{submission.pages.map((page) => {
        const info = coverage?.pages.find((entry) => entry.pageNumber === page.pageOrder + 1), state = pageState(info, !failed);
        const marks = fresh.filter((item) => item.pageId === page.id), wrong = marks.filter((item) => bucket(item) === "incorrect").length;
        return <figure key={page.id} className={`page-tile ${state}`} title={info?.reason || undefined}>
          <div><img src={page.processedUrl} alt={`第 ${page.pageOrder + 1} 页`} loading="lazy" />{marks.filter((item) => item.bbox).map((item) => <i key={item.id} className={`tile-mark ${bucket(item)}`} style={{ left: `${(item.bbox!.x + item.bbox!.width / 2) / 10}%`, top: `${(item.bbox!.y + item.bbox!.height / 2) / 10}%` }} />)}</div>
          <figcaption><span>{page.pageOrder + 1}</span><small>{marks.length ? `${marks.length} 题${wrong ? ` · ${wrong} 错` : ""}` : PAGE_LABEL[state]}</small></figcaption>
        </figure>;
      })}</div>
      <aside className="live-results">
        {current === 3 || fresh.length ? <>
          <h3>已批改 <b>{fresh.length}</b>{identified > 0 && <small> / {identified} 道</small>}</h3>
          <VerdictTally items={fresh} total={identified} />
          {recent.length ? <ol className="live-feed">{recent.map((item) => <li key={item.id} className={bucket(item)}><b>{homeworkQuestionLabel(item.questionNumber)}</b><span>{verdictLabel(item, international)}</span>{item.errorType && <small>{item.errorType}</small>}</li>)}</ol> : <p className="live-empty">批改完成的题目会逐一出现在这里。</p>}
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

/** IGCSE / A Level: the same report the PDF prints, with the download as the one main action. */
function InternationalReportCard({ report, onDownload, busy }: { report: InternationalReport; onDownload: (kind: "pdf" | "tex") => void; busy: boolean }) {
  return <article className="submission-report-card international-report"><header><span>批改报告 · 家长与学生共读</span><h2>{report.priorities.length ? `优先改进：${report.priorities.join("、")}` : "本次没有需要优先改进的问题"}</h2><p className="report-overview"><MathText text={report.overview} /></p></header>
    {report.practice.length > 0 && <section className="report-actions"><b>下一步练习</b><ol>{report.practice.map((row) => <li key={row.action}><MathText text={row.action} /><small>完成标准：<MathText text={row.standard} /></small></li>)}</ol></section>}
    {report.losses.length > 0 && <details className="report-losses"><summary>失分分析与订正（{report.losses.length} 项）</summary>{report.losses.map((loss) => <section key={`${loss.questionNumbers.join("-")}-${loss.title}`}><strong>第 {loss.questionNumbers.join("、")} 题：<MathText text={loss.title} /></strong>{([["失分事实", loss.fact], ["知识与能力", loss.knowledge], ["正确思路", loss.method], ["订正动作", loss.action]] as const).filter(([, value]) => value).map(([label, value]) => <p key={label}><b>{label}</b><MathText text={value} /></p>)}</section>)}</details>}
    <div className="report-download"><button className="primary" disabled={busy} onClick={() => onDownload("pdf")}>{busy ? "正在排版…" : "下载报告 PDF"}</button><button className="report-source" disabled={busy} onClick={() => onDownload("tex")}>下载 TeX</button></div>
  </article>;
}

export default function TeacherSubmissionPage() {
  const [id, setId] = useState("");
  const [submission, setSubmission] = useState<HomeworkSubmission | null>(null);
  const [items, setItems] = useState<GradingItem[]>([]);
  const [pages, setPages] = useState<HomeworkPage[]>([]);
  const [supplementPageId, setSupplementPageId] = useState("");
  const [supplementPages, setSupplementPages] = useState<HomeworkPage[]>([]);
  const [sourceDocuments, setSourceDocuments] = useState<File[]>([]);
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [editingId, setEditingId] = useState("");
  const [activeItemId, setActiveItemId] = useState("");
  const [split, setSplit] = useState(45);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  async function load(submissionId = id) {
    if (!submissionId) return;
    const result = await homeworkApi.submission(submissionId);
    setSubmission(result.submission);
    setItems(result.submission.gradingItems);

  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const submissionId = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) ?? "");
      setId(submissionId);
      void load(submissionId).catch((error) => setMessage(error instanceof Error ? error.message : "提交记录读取失败")).finally(() => setLoading(false));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!submission || !["submitted", "processing"].includes(submission.status)) return;
    const timer = setInterval(() => { void load(submission.id).catch(()=>{}); }, 4000);
    return () => clearInterval(timer);
  }, [submission?.id, submission?.status]);

  async function repairCoverage(){
    if(!submission)return;setBusy(true);
    try{const result=await homeworkApi.updateSubmission(submission.id,{action:"rebuild-coverage"});setSubmission(result.submission);setItems(result.submission.gradingItems);setMessage("已开始逐页补全与重批，修复前记录已保留。");}catch(error){setMessage(error instanceof Error?error.message:"补全失败");}finally{setBusy(false);}
  }
  async function attachFigures(){
    if(!submission)return;const before=submission.figuresPending??0;setBusy(true);setMessage("正在逐页定位并裁剪原卷配图，页数多时需要几分钟，请勿关闭本页…");
    try{const result=await homeworkApi.updateSubmission(submission.id,{action:"attach-figures"});setSubmission(result.submission);setItems(result.submission.gradingItems);const left=result.submission.figuresPending??0;setMessage(left?`已处理 ${before-left} 道题，仍有 ${left} 道题未完成，可再次提取`:"原卷配图已补全，错题本已同步");}catch(error){setMessage(error instanceof Error?error.message:"提取配图失败");}finally{setBusy(false);}
  }
  async function newVersion() {
    if(!submission)return;setBusy(true);
    try{const result=await homeworkApi.updateSubmission(submission.id,{action:"new-version"});location.href=`/tools/homework/submissions/${result.submission.id}`;}catch(error){setMessage(error instanceof Error?error.message:"创建重交版本失败");setBusy(false);}
  }
  async function reprocessPending() {
    if (!submission) return;
    setBusy(true); setMessage("正在补充待处理题目的材料…");
    try {
      const replacements=[];
      if(supplementPages.length) {
        if(supplementPages.length!==1 || !supplementPageId) throw new Error("请选择要替换的原页，每次补充一页");
        const asset=await uploadHomeworkAsset({blob:supplementPages[0].blob,fileName:"补充页面.jpg",role:"submission_original",submissionId:submission.id});
        replacements.push({replacePageId:supplementPageId,assetId:asset.id});
      }
      await uploadReferences();
      const result=await homeworkApi.updateSubmission(submission.id,{action:"reprocess-pending",pages:replacements});
      releaseHomeworkPages(supplementPages);setSubmission(result.submission);setItems(result.submission.gradingItems);setSupplementPages([]);setMessage("已重新处理待处理题，原始页面仍保留在历史原件中");
    } catch(error){setMessage(error instanceof Error?error.message:"重新处理失败");}finally{setBusy(false);}
  }

  // Reference answer pages are appended to the homework in the order they are chosen.
  async function uploadReferences() {
    if (!submission || !referenceFiles.length) return;
    const {renderImportFile}=await import("../../../../../lib/file-import");
    for(const file of referenceFiles){
      const blobs=file.type.startsWith("image/")?[file]:await Promise.all((await renderImportFile(file,()=>{})).map(async page=>(await fetch(page.image)).blob()));
      for(const blob of blobs)await uploadHomeworkAsset({blob,fileName:file.name,role:"answer",assignmentId:submission.assignmentId});
    }
    setReferenceFiles([]);
  }

  async function uploadAndSubmit() {
    if (!submission || !pages.length) return;
    setBusy(true);
    setMessage("正在上传作业原件…");
    try {
      for (const file of sourceDocuments) await uploadHomeworkAsset({blob:file,fileName:file.name,role:"submission_document",submissionId:submission.id});
      setSourceDocuments([]);
      const saved = [];
      for (const [index, page] of pages.entries()) {
        const asset = await uploadHomeworkAsset({ blob: page.blob, fileName: `${submission.studentName}-第${index + 1}页.jpg`, role: "submission_original", submissionId: submission.id });
        saved.push({ assetId: asset.id });
        setMessage(`正在上传第 ${index + 1}/${pages.length} 页…`);
      }
      await uploadReferences();
      await homeworkApi.updateSubmission(submission.id, { action: "save-pages", pages: saved });
      const result = await homeworkApi.updateSubmission(submission.id, { action: "submit" });
      releaseHomeworkPages(pages); setPages([]);
      setSubmission(result.submission);
      setItems(result.submission.gradingItems);
      setMessage("作业已提交，后台会自动批改并发布结果");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "作业提交失败");
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
      setMessage("判定已修正，错题本和作业报告已同步更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "修正失败");
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
      setMessage("旧提交结果已发布");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "旧提交处理失败");
    } finally { setBusy(false); }
  }

  async function retry() {
    if (!submission) return;
    setBusy(true);
    try {
      const result = await homeworkApi.updateSubmission(submission.id, { action: "retry" });
      setSubmission(result.submission);
      setMessage("已重新提交后台批改任务");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重试失败");
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
      if (kind === "tex") { saveBlob(new Blob([tex], { type: "application/x-tex" }), `${name}.tex`); setMessage("TeX 源文件已下载"); return; }
      const { compileLatexPdf, latexCompilerStatus } = await import("../../../../../lib/handout-latex-files");
      if (!(await latexCompilerStatus()).available) { setMessage("这台设备无法排版 PDF，请下载 TeX 源文件，或在运行知题的电脑上打开本页"); return; }
      const { pdf, issues } = await compileLatexPdf({ main: HOMEWORK_REPORT_MAIN, files: { [HOMEWORK_REPORT_MAIN]: new TextEncoder().encode(tex) }, missingFigures: 0 });
      saveBlob(pdf, `${name}.pdf`);
      setMessage(issues ? `报告 PDF 已生成，${issues} 处公式需要检查` : "报告 PDF 已生成");
    } catch (error) { setMessage(error instanceof Error ? error.message : "报告生成失败"); }
    finally { setBusy(false); }
  }

  async function refresh() {
    setBusy(true);
    try { await load(); setMessage("状态已刷新"); }
    finally { setBusy(false); }
  }

  if (loading) return <main className="homework-loading">正在读取学生作业…</main>;
  if (!submission) return <main className="homework-loading"><h1>提交记录不存在</h1><a href="/tools/homework">返回作业批改</a></main>;

  const report = submission.report;
  const live = ["submitted", "processing", "failed"].includes(submission.status);
  const summary = submission.gradingSummary;
  const marks = summary?.marks;
  const international = submission.curriculum === "international";
  const coverage = submission.pageCoverage;
  const incomplete = !!coverage && coverage.processed < coverage.total;
  const pendingPages = coverage?.pages.filter(page=>page.kind === "unreadable") ?? [];
  const pending = items.filter(item=>item.requiresReview || ["unreadable","review_required"].includes(item.verdict) || (["incorrect","partial"].includes(item.verdict) && (!item.standardAnswer || item.referenceVerified === false)));
  const issues = items.filter((item) => item.verdict === "partial" || item.verdict === "incorrect");
  const outputs = OUTPUT_LABELS.filter(([key])=>submission.outputs[key]).map(([,label])=>label);
  const status = incomplete && submission.status === "published" ? "结果不完整" : submission.status === "published" && coverage?.unreadable ? "有页面待补图" : STATUS[submission.status] ?? submission.status;

  return <main className="review-shell">
    <header className="review-topbar">{submission.outputs.wrongBook && !submission.outputs.report && !submission.outputs.profile ? <a href={`/?view=wrong-book&studentId=${encodeURIComponent(submission.studentId)}`}>← 学生错题本</a> : <a href="/tools/homework">← 作业批改</a>}<button onClick={refresh} disabled={busy}>刷新</button></header>
    {message && <div className="homework-notice" role="status">{message}<button onClick={() => setMessage("")} aria-label="关闭提示">×</button></div>}
    <section className="review-summary"><div><span className={`review-status ${submission.status}`}>{status}</span><h1>{submission.assignmentTitle}</h1><p>{[submission.studentName, `第 ${submission.version} 版`, `${submission.pages.length} 页`, ...(live ? [] : [`${items.length} 道题`, ...(items.length ? [`${issues.length} 处需要改进`] : [])]), outputs.length ? outputs.join("、") : "仅批改，不写入学生档案"].join(" · ")}</p></div>
      {!live && marks && <div className="review-score" aria-label="得分"><b>{marks.score}</b><span>/ {marks.maxScore}</span><small>{marks.percentage == null ? `${marks.pending} 题待定分` : `${marks.percentage}%`}</small></div>}</section>

    {live && <LiveBoard submission={submission} international={international} busy={busy} onRetry={incomplete ? repairCoverage : retry} />}
    {!live && coverage && (incomplete || coverage.unreadable > 0) && <section className="review-callout" aria-label="作业页面完整性"><div><b>{incomplete ? `${coverage.missing.length} 页未读取，当前结果不能代表整份作业` : `${coverage.unreadable} 页需要补图核实`}</b>{pageFailures(coverage).map((line) => <p key={line}>{line}</p>)}<ol className="page-chips" aria-label="逐页状态">{coverage.pages.map((page) => { const state = pageState(page, false); return <li key={page.pageNumber} className={state} title={`第 ${page.pageNumber} 页 · ${PAGE_LABEL[state]}`}>{page.pageNumber}</li>; })}</ol></div>{incomplete && ["published", "ready"].includes(submission.status) && <button className="primary" onClick={repairCoverage} disabled={busy}>补全页面并重新批改</button>}</section>}
    {!!submission.figuresPending && ["published","ready"].includes(submission.status) && <section className="review-callout"><div><b>{submission.figuresPending} 道题还没有原卷配图</b><p>错题本中的图形题会缺图。</p></div><button onClick={attachFigures} disabled={busy}>提取题目配图</button></section>}
    {summary && !live && !!items.length && <section className="review-ledger" aria-label="批改结果统计"><VerdictTally items={items} total={items.length} />{submission.outputs.wrongBook && <a href={`/?view=wrong-book&studentId=${submission.studentId}`}>已归档错题 {summary.archived} 道 →</a>}</section>}
    {submission.status === "published" && (pending.length>0 || pendingPages.length>0) && <details className="homework-panel pending-homework"><summary>{pending.length} 道题{pendingPages.length ? `、${pendingPages.length} 页` : ""}待处理 · 补充材料或修正判定</summary><p>已有结果会保留；需要补图或核实判定的题目暂不计入错题本，已按老师批改归档的题目会保留并补齐参考答案。</p><label>补图对应原页<select value={supplementPageId} disabled={busy} onChange={e=>setSupplementPageId(e.target.value)}><option value="">选择原页</option>{submission.pages.map((page,index)=><option key={page.id} value={page.id}>第 {index+1} 页</option>)}</select></label><HomeworkPagePicker pages={supplementPages} onChange={setSupplementPages} disabled={busy} limit={1} /><label>补充参考答案（选填）<input type="file" aria-label="待处理题参考答案" multiple accept="image/*,application/pdf" disabled={busy} onChange={e=>setReferenceFiles([...(e.target.files??[])])} /></label><button className="primary" onClick={reprocessPending} disabled={busy || (supplementPages.length>0 && (!supplementPageId || supplementPages.length!==1))}>{busy?"正在处理…":"重新处理待处理题"}</button><p>也可以在下方对应题目中补充参考答案并修正判定。</p></details>}


    {submission.status === "draft" && <section className="review-upload"><div><h2>上传学生作业</h2><p>支持照片、PDF，每份最多30页。</p></div><HomeworkPagePicker pages={pages} onChange={setPages} disabled={busy} onSourceFile={file=>setSourceDocuments(current=>[...current,file])} /><details className="completed-reference"><summary>参考答案（选填）</summary><input aria-label="补充参考答案" type="file" multiple accept="image/*,application/pdf" onChange={e=>setReferenceFiles([...(e.target.files??[])])} /></details><button className="primary upload-submit" disabled={busy || !pages.length} onClick={uploadAndSubmit}>{busy ? "正在上传…" : `提交 ${pages.length} 页作业`}</button></section>}


    {["review_required", "ready"].includes(submission.status) && <section className="legacy-result-banner"><div><b>这是启用自动发布前产生的旧提交</b><p>保留旧流程兼容，不会被后台自动发布。</p></div><button className="primary" onClick={finishLegacySubmission} disabled={busy}>确认并发布</button></section>}

    {["review_required", "ready", "published"].includes(submission.status) && <>
      {submission.outputs.report && international && report?.details && <section className="diagnosis-grid"><InternationalReportCard report={report.details} onDownload={downloadReport} busy={busy} /></section>}
      {submission.outputs.report && !international && <section className="diagnosis-grid">
        <article className="submission-report-card"><header><span>整份诊断</span><h2>{report?.overallSummary || "逐题结果已完成"}</h2><p>{report?.studentMessage || "当前提交尚未生成整份建议。"}</p></header>{report && <><div className="report-columns"><section><b>做得好的地方</b>{report.strengths.length ? report.strengths.map((point) => <div key={`${point.title}-${point.questionNumbers.join("-")}`}><strong>{point.title}</strong><p>{point.detail}</p><small>{point.questionNumbers.map(homeworkQuestionLabel).join("、")}</small></div>) : <p className="report-empty">本次暂无足够证据。</p>}</section><section><b>优先改进</b>{report.gaps.length ? report.gaps.map((point) => <div key={`${point.title}-${point.questionNumbers.join("-")}`}><strong>{point.title}</strong><p>{point.detail}</p><small>{point.questionNumbers.map(homeworkQuestionLabel).join("、")}</small></div>) : <p className="report-empty">暂未发现优先问题。</p>}</section></div><section className="report-actions"><b>下一步建议</b><ol>{report.actions.map((action) => <li key={action}>{action}</li>)}</ol></section></>}</article>
      </section>}

      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll this region independently. */}
      {!!submission.pages.length && <section className="review-evidence-layout" style={{ "--review-split": `${split}%` } as CSSProperties}><div className="review-pages" id="review-originals" role="region" aria-label="原卷标记，独立滚动" tabIndex={0}><h2>原卷标记</h2>{submission.pages.map((page, index) => <figure id={`page-${page.id}`} key={page.id}><div className="graded-page"><img src={page.processedUrl} alt={`${submission.studentName}答卷第 ${index + 1} 页`} />{items.filter((item) => item.pageId === page.id && item.bbox).map((item) => <button id={`marker-${item.id}`} key={item.id} className={`grade-marker ${item.verdict}`} aria-pressed={activeItemId === item.id} style={{ left: `${item.bbox!.x / 10}%`, top: `${item.bbox!.y / 10}%`, width: `${item.bbox!.width / 10}%`, height: `${item.bbox!.height / 10}%` }} onClick={() => focusEvidence(item, true)} aria-label={`查看${homeworkQuestionLabel(item.questionNumber)}`}>{item.verdict === "correct" ? "✓" : item.verdict === "partial" ? "△" : item.verdict === "incorrect" ? "×" : "?"}</button>)}</div><figcaption>第 {index + 1} 页</figcaption></figure>)}</div>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- A focusable ARIA window splitter supports pointer and keyboard resizing. */}
        <div className="review-splitter" role="separator" aria-label="调整原卷与详情宽度" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={70} aria-valuenow={split} aria-controls="review-originals review-details" tabIndex={0}
          onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = event.currentTarget.parentElement!.getBoundingClientRect(); setSplit(Math.max(30, Math.min(70, Math.round((event.clientX - box.left) / box.width * 100)))); }}
          onPointerUp={event => { if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId); }}
          onDoubleClick={() => setSplit(45)}
          onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); setSplit(current => event.key === "Home" ? 30 : event.key === "End" ? 70 : Math.max(30, Math.min(70, current + (event.key === "ArrowLeft" ? -2 : 2)))); }} />
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll this region independently. */}
        <div className="grading-list" id="review-details" role="region" aria-label="逐题详情，独立滚动" tabIndex={0}><div className="grading-heading"><div><h2>逐题证据</h2><p>展开题目查看学生作答、参考答案和判定依据。</p></div></div>{items.map((item) => {
          const editing = editingId === item.id;
          return <details id={`grading-${item.id}`} key={item.id} className={`grading-card compact ${item.verdict}${activeItemId === item.id ? " selected" : ""}`} onToggle={event => { if (event.currentTarget.open) focusEvidence(item); }} open={editing || undefined}><summary><span>{homeworkQuestionLabel(item.questionNumber)}</span><b>{verdictLabel(item, international)}</b><small>{item.teacherMark ? "老师批改" : `${Math.round(item.confidence * 100)}% 置信度`}</small></summary><div className="grading-detail">{international && <p className="grading-stem"><MathText text={item.stem} /></p>}{international && !!item.figures?.length && <div className="grading-figures">{item.figures.map((figure, index) => <img key={figure.url} className={figure.kind} src={figure.url} alt={`${homeworkQuestionLabel(item.questionNumber)}配图 ${index + 1}`} loading="lazy" />)}</div>}{editing ? <><div className="grading-fields"><label>批改结论<select value={item.verdict} onChange={(event) => updateItem(item.id, reconcileHomeworkScore(event.target.value as GradingItem["verdict"], null, item.maxScore, submission.curriculum))}><option value="correct">正确</option><option value="partial">部分正确</option><option value="incorrect">错误</option><option value="unreadable">{international ? "看不清（0 分）" : "待补图"}</option><option value="review_required">待核实</option></select></label><label>错误类型<input value={item.errorType} onChange={(event) => updateItem(item.id, { errorType: event.target.value })} placeholder="计算、审题、步骤…" /></label><label>满分<input type="number" min={0} step={0.5} inputMode="decimal" value={item.maxScore ?? ""} onChange={(event) => { const maxScore = event.target.value === "" ? null : Number(event.target.value); updateItem(item.id, { maxScore, ...reconcileHomeworkScore(item.verdict, item.score, maxScore, submission.curriculum) }); }} placeholder="原卷无分值可留空" /></label>{item.maxScore != null && <label>得分<input type="number" min={0} max={item.maxScore} step={0.5} inputMode="decimal" value={item.score ?? ""} onChange={(event) => updateItem(item.id, event.target.value === "" ? { score: null } : reconcileHomeworkScore("partial", event.target.value, item.maxScore))} /></label>}</div><label>题干<textarea rows={3} value={item.stem} onChange={event=>updateItem(item.id,{stem:event.target.value})} /></label><label>参考答案<input value={item.standardAnswer} onChange={event=>updateItem(item.id,{standardAnswer:event.target.value})} /></label><label>参考解析<textarea rows={3} value={item.standardAnalysis} onChange={event=>updateItem(item.id,{standardAnalysis:event.target.value})} /></label><label><input type="checkbox" checked={item.referenceVerified === true} onChange={event=>updateItem(item.id,{referenceVerified:event.target.checked})} />我已核实题目与参考解答</label><label>学生作答<textarea rows={2} value={item.studentAnswer} onChange={(event) => updateItem(item.id, { studentAnswer: event.target.value })} /></label><label>给学生的反馈<textarea rows={3} value={item.feedback} onChange={(event) => updateItem(item.id, { feedback: event.target.value })} /></label><div className="correction-actions"><button onClick={() => { setEditingId(""); void load(submission.id); }}>取消</button><button className="primary" onClick={() => saveCorrection(item)} disabled={busy}>保存修正</button></div></> : <>{international && item.stepAnalysis.length > 0 && <div className="step-analysis"><b>步骤分析</b><ol>{item.stepAnalysis.map((step) => <li key={step}>{step}</li>)}</ol></div>}{item.standardAnswer && <div className="standard-answer"><b>参考答案 · {item.referenceSource === "agent" ? "Agent 解题" : item.referenceSource === "unresolved" ? "待校验" : "教师提供"}</b><p><MathText text={item.standardAnswer} /></p>{item.standardAnalysis && <small><MathText text={item.standardAnalysis} /></small>}</div>}{international && (item.evidenceSummary || item.feedback || item.errorType) && <div className="evidence-feedback"><b>判定依据与反馈</b><p>{[item.evidenceSummary, item.feedback].filter(Boolean).join("。")}</p>{item.errorType && <small>问题标签：{item.errorType}</small>}</div>}{!item.standardAnswer && <p className="reference-empty">{item.teacherMark === "correct" ? "老师已判为正确，无需补充参考答案。" : item.referenceEvidence || item.feedback || "参考答案待补全，可在上方待处理区重新处理。"}</p>}{submission.status === "published" && <button className="quiet-correction" onClick={() => setEditingId(item.id)}>修正判定</button>}</>}</div></details>;
        })}</div>
      </section>}
    </>}
    {submission.status === "published" && <details className="homework-panel review-archive-panel"><summary>重新提交本份作业</summary><p>新的作答单独保留一版，之前的批改和原件不会覆盖。</p><button className="primary" disabled={busy} onClick={newVersion}>上传新版本</button></details>}
    {!!submission.originalDocuments?.length && <details className="homework-panel review-archive-panel"><summary>上传的 PDF 原件</summary><div className="original-files">{submission.originalDocuments.map((document,index)=><a key={index} className="original-file" href={document.url} target="_blank" rel="noreferrer"><svg className="pdf-icon" viewBox="0 0 32 40" aria-hidden="true" focusable="false"><path d="M7 1.5h13.5l9 9v24a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-29a4 4 0 0 1 4-4Z" /><path d="M20.5 1.5v6a3 3 0 0 0 3 3h6" /><rect x="0" y="20" width="23" height="11" rx="2.5" /><text x="11.5" y="28.3">PDF</text></svg><span><b>{document.name}</b><small>学生上传的原件 · 点击在新窗口打开</small></span><svg className="open-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 17 17 7M9 7h8v8" /></svg></a>)}</div></details>}
    {!!submission.pageRevisions?.length && <details className="homework-panel review-archive-panel"><summary>历史作业原件</summary>{submission.pageRevisions.map((revision,index)=><p key={index}><a href={revision.originalUrl} target="_blank" rel="noreferrer">补图前原件 · {new Date(revision.createdAt).toLocaleString("zh-CN")}</a></p>)}</details>}
  </main>;
}
