"use client";

import { useEffect, useState } from "react";
import DocumentScanner, { type ScannedHomeworkPage } from "../../../components/DocumentScanner";
import { MathText } from "../../../components/MathText";
import { homeworkApi, uploadHomeworkAsset } from "../../../../lib/homework-api-client";
import type { GradingItem, HomeworkSubmission } from "../../../../lib/types";

const STATUS: Record<string, string> = {
  draft: "答卷草稿", submitted: "已提交", processing: "自动批改中", review_required: "旧版待复核",
  ready: "旧版待发布", published: "结果已发布", returned: "已自动退回", failed: "处理失败",
};
const VERDICT: Record<string, string> = { correct: "正确", partial: "部分正确", incorrect: "错误", unreadable: "待补图", review_required: "待核实" };

export default function TeacherSubmissionPage() {
  const [id, setId] = useState("");
  const [submission, setSubmission] = useState<HomeworkSubmission | null>(null);
  const [items, setItems] = useState<GradingItem[]>([]);
  const [pages, setPages] = useState<ScannedHomeworkPage[]>([]);
  const [supplementPageId, setSupplementPageId] = useState("");
  const [supplementPages, setSupplementPages] = useState<ScannedHomeworkPage[]>([]);
  const [sourceDocuments, setSourceDocuments] = useState<File[]>([]);
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [editingId, setEditingId] = useState("");
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
  async function newVersion() {
    if(!submission)return;setBusy(true);
    try{const result=await homeworkApi.createSubmission(submission.assignmentId,submission.studentId,true);location.href=`/homework/submissions/${result.submission.id}`;}catch(error){setMessage(error instanceof Error?error.message:"创建重交版本失败");setBusy(false);}
  }
  async function reprocessPending() {
    if (!submission) return;
    setBusy(true); setMessage("正在补充待处理题目的材料…");
    try {
      const replacements=[];
      if(supplementPages.length) {
        if(supplementPages.length!==1 || !supplementPageId) throw new Error("请选择要替换的原页，每次补充一页");
        const page=supplementPages[0];
        const original=await uploadHomeworkAsset({blob:page.original,fileName:"补充原件.jpg",role:"submission_original",pageOrder:0,submissionId:submission.id});
        const processed=await uploadHomeworkAsset({blob:page.processed,fileName:"补充校准.jpg",role:"submission_processed",pageOrder:0,submissionId:submission.id});
        replacements.push({replacePageId:supplementPageId,originalAssetId:original.id,processedAssetId:processed.id,quality:page.quality});
      }
      if(referenceFiles.length) {
        if(submission.inputMode!=="completed_homework") throw new Error("模板作业请在题目修正中补充参考答案");
        const assignment=(await homeworkApi.readAssignment(submission.assignmentId)).assignment;
        let order=assignment.assets.filter(asset=>asset.role==="answer").length;
        const {renderImportFile}=await import("../../../../lib/file-import");
        for(const file of referenceFiles){
          const blobs=file.type.startsWith("image/")?[file]:await Promise.all((await renderImportFile(file,()=>{})).map(async page=>(await fetch(page.image)).blob()));
          for(const blob of blobs)await uploadHomeworkAsset({blob,fileName:file.name,role:"answer",pageOrder:order++,assignmentId:submission.assignmentId});
        }
      }
      const result=await homeworkApi.updateSubmission(submission.id,{action:"reprocess-pending",pages:replacements});
      setSubmission(result.submission);setItems(result.submission.gradingItems);setSupplementPages([]);setMessage("已重新处理待处理题，原始页面仍保留在历史原件中");
    } catch(error){setMessage(error instanceof Error?error.message:"重新处理失败");}finally{setBusy(false);}
  }

  function releasePages() {
    for (const page of pages) { URL.revokeObjectURL(page.originalUrl); URL.revokeObjectURL(page.processedUrl); }
    setPages([]);
  }

  async function uploadAndSubmit() {
    if (!submission || !pages.length) return;
    if (submission.inputMode !== "completed_homework" && pages.some((page) => page.quality.blocking)) { setMessage("存在模糊、过暗或重复页面，请处理后再提交"); return; }
    setBusy(true);
    setMessage("正在上传答卷原件…");
    try {
      for (const file of sourceDocuments) await uploadHomeworkAsset({blob:file,fileName:file.name,role:"submission_document",pageOrder:0,submissionId:submission.id});
      const saved = [];
      for (const [index, page] of pages.entries()) {
        const original = await uploadHomeworkAsset({ blob: page.original, fileName: `${submission.studentName}-原件-${index + 1}.jpg`, role: "submission_original", pageOrder: index, submissionId: submission.id });
        const processed = await uploadHomeworkAsset({ blob: page.processed, fileName: `${submission.studentName}-校准-${index + 1}.jpg`, role: "submission_processed", pageOrder: index, submissionId: submission.id });
        saved.push({ originalAssetId: original.id, processedAssetId: processed.id, quality: { ...page.quality, corners: page.corners } });
        setMessage(`正在上传第 ${index + 1}/${pages.length} 页…`);
      }
      let referenceOrder=0;
      for(const file of referenceFiles) {
        const {renderImportFile}=await import("../../../../lib/file-import");
        const blobs=file.type.startsWith("image/")?[file]:await Promise.all((await renderImportFile(file,()=>{})).map(async page=>(await fetch(page.image)).blob()));
        for(const blob of blobs)await uploadHomeworkAsset({blob,fileName:file.name,role:"answer",pageOrder:referenceOrder++,assignmentId:submission.assignmentId});
      }
      await homeworkApi.updateSubmission(submission.id, { action: "save-pages", pages: saved });
      const result = await homeworkApi.updateSubmission(submission.id, { action: "submit" });
      releasePages();
      setSubmission(result.submission);
      setItems(result.submission.gradingItems);
      setMessage("答卷已提交，后台会自动批改并发布正常结果");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "答卷提交失败");
    } finally { setBusy(false); }
  }

  function updateItem(itemId: string, patch: Partial<GradingItem>) {
    setItems((current) => current.map((item) => item.id === itemId ? { ...item, ...patch } : item));
  }

  async function saveCorrection(item: GradingItem) {
    if (!submission) return;
    setBusy(true);
    try {
      const result = await homeworkApi.updateSubmission(submission.id, { action: "correct", items: [{
        id: item.id, verdict: item.verdict, standardAnswer:item.standardAnswer, standardAnalysis:item.standardAnalysis, referenceVerified:item.referenceVerified, stem:item.stem, studentAnswer: item.studentAnswer, feedback: item.feedback,
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

  async function returnForPhoto() {
    if (!submission) return;
    const reason = window.prompt("填写退回原因", "照片模糊或漏页，请重新拍摄完整清晰的答卷");
    if (reason == null) return;
    setBusy(true);
    try {
      const result = await homeworkApi.updateSubmission(submission.id, { action: "return", reason });
      setSubmission(result.submission);
      setMessage("已退回，学生可以重新提交照片");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "退回失败");
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

  async function refresh() {
    setBusy(true);
    try { await load(); setMessage("状态已刷新"); }
    finally { setBusy(false); }
  }

  if (loading) return <main className="homework-loading">正在读取学生答卷…</main>;
  if (!submission) return <main className="homework-loading"><h1>提交记录不存在</h1><a href="/homework">返回作业中心</a></main>;

  const report = submission.report;
  const activeProcessing=["submitted","processing"].includes(submission.status);
  const summary = submission.gradingSummary;
  const pendingPages = submission.pageCoverage?.pages.filter(page=>page.kind === "unreadable") ?? [];
  const pending = items.filter(item=>item.requiresReview || ["unreadable","review_required"].includes(item.verdict));
  const issues = items.filter((item) => item.verdict === "partial" || item.verdict === "incorrect");

  return <main className="review-shell">
    <header className="review-topbar"><a href="/homework">← 返回作业中心</a><div><span>{submission.studentName}</span><b>{submission.assignmentTitle}</b></div><button onClick={refresh} disabled={busy}>刷新</button></header>
    {message && <div className="homework-notice" role="status">{message}<button onClick={() => setMessage("")} aria-label="关闭提示">×</button></div>}
    <section className="review-summary"><div><span>{submission.pageCoverage && submission.pageCoverage.processed<submission.pageCoverage.total && submission.status === "published" ? "已有结果不完整" : submission.status === "published" && submission.pageCoverage?.unreadable ? "结果已保存，有页面待补图" : STATUS[submission.status] ?? submission.status}</span><h1>{submission.studentName} · 第 {submission.version} 版</h1><p>{submission.pages.length} 页 · {activeProcessing ? `本次已批改 ${submission.processingProgress?.graded ?? 0} 道` : `${items.length} 道题${items.length ? ` · ${issues.length} 处需要改进` : ""}`}</p></div>{!["published", "returned", "draft"].includes(submission.status) && <details className="review-more-actions"><summary>更多操作</summary><button onClick={returnForPhoto}>手动退回</button></details>}</section>


    {submission.pageCoverage && <section className="homework-page-coverage" aria-label="作业页面完整性"><b>已核验页面 {submission.pageCoverage.processed} / {submission.pageCoverage.total}</b>{activeProcessing && submission.pageCoverage.processed === submission.pageCoverage.total && <p>已识别 {submission.processingProgress?.identified ?? 0} 道题，参考解答已处理 {submission.processingProgress?.referenceChecked ?? 0} 道，正在逐批核验与批改。</p>}{!!submission.pageCoverage.unreadable && <span>{submission.pageCoverage.unreadable} 页需补图核实</span>}{submission.pageCoverage.processed<submission.pageCoverage.total && <p>尚未确认第 {submission.pageCoverage.missing.join("、")} 页，当前结果不能代表整份作业。</p>}{["published","ready","failed"].includes(submission.status)&&submission.pageCoverage.processed<submission.pageCoverage.total && <button className="primary" onClick={repairCoverage} disabled={busy}>补全页面并重新批改</button>}<details><summary>逐页处理情况</summary>{submission.pageCoverage.pages.map(page=><p key={page.pageNumber}>第 {page.pageNumber} 页 · {page.valid ? page.kind === "blank" ? "已确认空白" : page.kind === "unreadable" ? "待补图" : "已核验" : "未完成"}{page.reason ? `：${page.reason}` : ""}</p>)}</details></section>}
    {summary && !activeProcessing && !!items.length && <section className="grading-counts" aria-label="批改结果统计"><span>正确 <b>{summary.correct}</b></span><span>部分正确 <b>{summary.partial}</b></span><span>错误 <b>{summary.incorrect}</b></span><span>待处理 <b>{summary.unresolved}</b></span><a href={`/?view=wrong-book&studentId=${submission.studentId}`}>已归档错题 <b>{summary.archived}</b></a></section>}
    {submission.status === "published" && (pending.length>0 || pendingPages.length>0) && <details className="homework-panel pending-homework"><summary>{pending.length} 道题{pendingPages.length ? `、${pendingPages.length} 页` : ""}待处理 · 补充材料或修正判定</summary><p>其他题目的结果已保存；待处理题暂不计入错题本或学习能力证据。</p><label>补图对应原页<select value={supplementPageId} disabled={busy} onChange={e=>setSupplementPageId(e.target.value)}><option value="">选择原页</option>{submission.pages.map((page,index)=><option key={page.id} value={page.id}>第 {index+1} 页</option>)}</select></label><DocumentScanner pages={supplementPages} onChange={setSupplementPages} disabled={busy} defaultEnhance={false} />{submission.inputMode === "completed_homework" && <label>补充参考答案（选填）<input type="file" aria-label="待处理题参考答案" multiple accept="image/*,application/pdf" disabled={busy} onChange={e=>setReferenceFiles([...(e.target.files??[])])} /></label>}<button className="primary" onClick={reprocessPending} disabled={busy || (supplementPages.length>0 && (!supplementPageId || supplementPages.length!==1))}>{busy?"正在处理…":"重新处理待处理题"}</button><p>也可以在下方对应题目中补充参考答案并修正判定。</p></details>}


    {submission.status === "draft" && <section className="review-upload"><div><h2>代传学生答卷</h2><p>完成页面校正后提交；严重模糊、过暗或重复页会被拦截。</p></div><DocumentScanner pages={pages} onChange={setPages} disabled={busy} allowPdf={submission.inputMode === "completed_homework"} onSourceFile={file=>setSourceDocuments(current=>[...current,file])} />{submission.inputMode === "completed_homework" && <details className="completed-reference"><summary>参考答案（选填）</summary><input aria-label="补充参考答案" type="file" multiple accept="image/*,application/pdf" onChange={e=>setReferenceFiles([...(e.target.files??[])])} /></details>}<button className="primary upload-submit" disabled={busy || !pages.length || (submission.inputMode !== "completed_homework" && pages.some((page) => page.quality.blocking))} onClick={uploadAndSubmit}>{busy ? "正在上传…" : `提交 ${pages.length} 页答卷`}</button></section>}

    {["submitted", "processing", "failed"].includes(submission.status) && <section className={`processing-card ${submission.status}`}><i></i><h2>{submission.status === "failed" ? "自动批改遇到问题" : "正在自动批改"}</h2><p>{submission.failureReason || "可以离开本页，结果完成后会自动保存。"}</p>{submission.status === "failed" && <button className="primary" onClick={retry} disabled={busy}>重新批改</button>}</section>}

    {submission.status === "returned" && <section className="returned-diagnosis"><span>需重新提交</span><h2>这次照片无法可靠批改</h2><p>{submission.failureReason || "请重新拍摄完整、清晰的答卷。"}</p><small>本次不会写入错题本，也不会形成负面能力证据。</small></section>}

    {["review_required", "ready"].includes(submission.status) && <section className="legacy-result-banner"><div><b>这是启用自动发布前产生的旧提交</b><p>保留旧流程兼容，不会被后台自动发布。</p></div><button className="primary" onClick={finishLegacySubmission} disabled={busy}>确认并发布</button></section>}

    {["review_required", "ready", "published"].includes(submission.status) && <>
      <section className="diagnosis-grid">
        <article className="submission-report-card"><header><span>整份诊断</span><h2>{report?.overallSummary || "逐题结果已完成"}</h2><p>{report?.studentMessage || "当前提交尚未生成整份建议。"}</p></header>{report && <><div className="report-columns"><section><b>做得好的地方</b>{report.strengths.length ? report.strengths.map((point) => <div key={`${point.title}-${point.questionNumbers.join("-")}`}><strong>{point.title}</strong><p>{point.detail}</p><small>{point.questionNumbers.map((number) => `第 ${number} 题`).join("、")}</small></div>) : <p className="report-empty">本次暂无足够证据。</p>}</section><section><b>优先改进</b>{report.gaps.length ? report.gaps.map((point) => <div key={`${point.title}-${point.questionNumbers.join("-")}`}><strong>{point.title}</strong><p>{point.detail}</p><small>{point.questionNumbers.map((number) => `第 ${number} 题`).join("、")}</small></div>) : <p className="report-empty">暂未发现优先问题。</p>}</section></div><section className="report-actions"><b>下一步建议</b><ol>{report.actions.map((action) => <li key={action}>{action}</li>)}</ol></section></>}</article>
      </section>

      {!!submission.pages.length && <section className="review-evidence-layout"><div className="review-pages"><h2>原卷标记</h2>{submission.pages.map((page, index) => <figure key={page.id}><div className="graded-page"><img src={page.processedUrl} alt={`${submission.studentName}答卷第 ${index + 1} 页`} />{items.filter((item) => item.pageId === page.id && item.bbox).map((item) => <button key={item.id} className={`grade-marker ${item.verdict}`} style={{ left: `${item.bbox!.x / 10}%`, top: `${item.bbox!.y / 10}%`, width: `${item.bbox!.width / 10}%`, height: `${item.bbox!.height / 10}%` }} onClick={() => document.getElementById(`grading-${item.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })} aria-label={`查看第 ${item.questionNumber} 题`}>{item.verdict === "correct" ? "✓" : item.verdict === "partial" ? "△" : item.verdict === "incorrect" ? "×" : "?"}</button>)}</div><figcaption>第 {index + 1} 页 · 清晰度 {Math.round(page.quality.score * 100)}%</figcaption></figure>)}</div>
        <div className="grading-list"><div className="grading-heading"><div><h2>逐题证据</h2><p>展开题目查看学生步骤、标准答案和判定依据。</p></div></div>{items.map((item) => {
          const editing = editingId === item.id;
          return <details id={`grading-${item.id}`} key={item.id} className={`grading-card compact ${item.verdict}`} open={editing || undefined}><summary><span>第 {item.questionNumber} 题</span><b>{VERDICT[item.verdict] ?? item.verdict}</b><small>{Math.round(item.confidence * 100)}% 置信度</small></summary><div className="grading-detail"><p className="grading-stem"><MathText text={item.stem} /></p>{editing ? <><div className="grading-fields"><label>批改结论<select value={item.verdict} onChange={(event) => updateItem(item.id, { verdict: event.target.value as GradingItem["verdict"] })}><option value="correct">正确</option><option value="partial">部分正确</option><option value="incorrect">错误</option><option value="unreadable">待补图</option><option value="review_required">待核实</option></select></label><label>错误类型<input value={item.errorType} onChange={(event) => updateItem(item.id, { errorType: event.target.value })} placeholder="计算、审题、步骤…" /></label></div><label>题干<textarea rows={3} value={item.stem} onChange={event=>updateItem(item.id,{stem:event.target.value})} /></label><label>参考答案<input value={item.standardAnswer} onChange={event=>updateItem(item.id,{standardAnswer:event.target.value})} /></label><label>参考解析<textarea rows={3} value={item.standardAnalysis} onChange={event=>updateItem(item.id,{standardAnalysis:event.target.value})} /></label><label><input type="checkbox" checked={item.referenceVerified === true} onChange={event=>updateItem(item.id,{referenceVerified:event.target.checked})} />我已核实题目与参考解答</label><label>学生作答<textarea rows={2} value={item.studentAnswer} onChange={(event) => updateItem(item.id, { studentAnswer: event.target.value })} /></label><label>给学生的反馈<textarea rows={3} value={item.feedback} onChange={(event) => updateItem(item.id, { feedback: event.target.value })} /></label><div className="correction-actions"><button onClick={() => { setEditingId(""); void load(submission.id); }}>取消</button><button className="primary" onClick={() => saveCorrection(item)} disabled={busy}>保存修正</button></div></> : <><div className="student-answer-block"><b>学生作答</b><p><MathText text={item.studentAnswer || (item.errorType === "漏答" ? "空白（未作答）" : "未识别到作答")} /></p></div>{item.stepAnalysis.length > 0 && <div className="step-analysis"><b>步骤分析</b><ol>{item.stepAnalysis.map((step) => <li key={step}>{step}</li>)}</ol></div>}<div className="standard-answer"><b>参考答案 · {item.referenceSource === "agent" ? "Agent 解题" : item.referenceSource === "unresolved" ? "待校验" : "教师提供"}</b><p><MathText text={item.standardAnswer} /></p>{item.standardAnalysis && <small><MathText text={item.standardAnalysis} /></small>}</div><div className="evidence-feedback"><b>判定依据与反馈</b><p>{item.evidenceSummary || item.feedback}</p>{item.errorType && <small>问题标签：{item.errorType}</small>}</div>{submission.status === "published" && <button className="quiet-correction" onClick={() => setEditingId(item.id)}>修正判定</button>}</>}</div></details>;
        })}</div>
      </section>}
    </>}
    {submission.status === "published" && <details className="homework-panel review-archive-panel"><summary>重新提交本份作业</summary><p>新的作答单独保留一版，之前的批改和原件不会覆盖。</p><button className="primary" disabled={busy} onClick={newVersion}>上传新版本</button></details>}
    {!!submission.originalDocuments?.length && <details className="homework-panel review-archive-panel"><summary>上传的 PDF 原件</summary>{submission.originalDocuments.map((document,index)=><p key={index}><a href={document.url} target="_blank" rel="noreferrer">{document.name}</a></p>)}</details>}
    {!!submission.pageRevisions?.length && <details className="homework-panel review-archive-panel"><summary>历史作业原件</summary>{submission.pageRevisions.map((revision,index)=><p key={index}><a href={revision.originalUrl} target="_blank" rel="noreferrer">补图前原件 · {new Date(revision.createdAt).toLocaleString("zh-CN")}</a></p>)}</details>}
  </main>;
}
