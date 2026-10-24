"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { SiteHeader } from "../../../../components/SiteHeader";
import { PaperMoreMenu } from "../../../../components/PaperMoreMenu";
import { fetchMe } from "../../../../../lib/api-client";
import { AssignedHomeworkSheet, confirmGivingUp, dayNote, resultState, uploadNote, VerdictTally } from "../../../../components/AssignedHomeworkSheet";
import HomeworkPagePicker, { releaseHomeworkPages, type HomeworkPage } from "../../../../components/HomeworkPagePicker";
import { MathText } from "../../../../components/MathText";
import { homeworkApi, uploadHomeworkAsset } from "../../../../../lib/homework-api-client";
import { homeworkQuestionLabel, isPendingGradingItem, reconcileHomeworkScore, titleWithoutStudent } from "../../../../../lib/homework-grading-rules.mjs";
import { rotateNormalizedBox } from "../../../../../lib/image-processing-rules.mjs";
import type { AuthUser, GradingItem, HomeworkSubmission, InternationalReport, Question } from "../../../../../lib/types";

const STATUS: Record<string, string> = {
  draft: "待上传", submitted: "已提交", processing: "自动批改中", review_required: "旧版待复核",
  ready: "旧版待发布", published: "结果已发布", failed: "处理失败",
};
const VERDICT: Record<string, string> = { correct: "正确", partial: "部分正确", incorrect: "错误", unreadable: "待补图", review_required: "待核实" };
function verdictLabel(item: GradingItem, international: boolean) {
  const label = !international && item.verdict === "partial" ? "错误" : international && item.verdict === "unreadable" ? "看不清" : VERDICT[item.verdict] ?? item.verdict;
  return item.maxScore != null && item.score != null ? `${label} · ${item.score}/${item.maxScore} 分` : label;
}

/** Rotate the pixels, so normal document flow, image decoding and the PDF exporter share the upright image. */
function HomeworkPageImage({ page, alt, loading }: { page: HomeworkSubmission["pages"][number]; alt: string; loading?: "lazy" }) {
  const [upright, setUpright] = useState("");
  // eslint-disable-next-line @next/next/no-img-element -- Preserve the page pixels and the same decoded image in PDF export.
  return <img src={upright || page.processedUrl} alt={alt} loading={loading} data-orienting={Boolean(page.rotation && !upright) || undefined} onLoad={event => {
    if (!page.rotation || upright) return;
    const image = event.currentTarget, canvas = document.createElement("canvas");
    const swap = page.rotation === 90 || page.rotation === 270;
    canvas.width = swap ? image.naturalHeight : image.naturalWidth; canvas.height = swap ? image.naturalWidth : image.naturalHeight;
    const context = canvas.getContext("2d"); if (!context) return;
    context.translate(canvas.width / 2, canvas.height / 2); context.rotate(page.rotation * Math.PI / 180);
    context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
    setUpright(canvas.toDataURL("image/png")); canvas.width = canvas.height = 0;
  }} />;
}

/** The same measured layout places notes and connectors on screen and in the PDF. */
function gradedPageLayout(element: HTMLElement) {
  const image = element.querySelector(".graded-page>img");
  if (!image) return;
  const bounds = element.getBoundingClientRect(), imageBounds = image.getBoundingClientRect();
  const notes = Array.from(element.querySelectorAll<HTMLElement>(".error-callout"), note => ({
    note: note.getBoundingClientRect(), mark: element.querySelector(`#${CSS.escape(note.dataset.markerId!)}`)?.getBoundingClientRect(),
  }));
  if (!imageBounds.height || notes.some(({ mark }) => !mark)) return;
  const height = Math.ceil(Math.max(imageBounds.height, notes.reduce((sum, { note }) => sum + note.height + 12, 12)));
  let bottom = 12;
  const tops = notes.map(({ note, mark }) => {
    const top = Math.max(bottom, mark!.top - bounds.top + mark!.height / 2 - note.height / 2);
    bottom = top + note.height + 12;
    return top;
  });
  bottom = height - 12;
  for (let index = notes.length - 1; index >= 0; index--) {
    tops[index] = Math.round(Math.min(tops[index], bottom - notes[index].note.height));
    bottom = tops[index] - 12;
  }
  const paths = notes.map(({ note, mark }, index) => {
    const x = note.right - bounds.left, y = tops[index] + note.height / 2;
    const targetX = mark!.left - bounds.left - 3, targetY = mark!.top - bounds.top + mark!.height / 2;
    const elbow = imageBounds.left - bounds.left - 12;
    return `M ${x.toFixed(1)} ${y.toFixed(1)} H ${elbow.toFixed(1)} V ${targetY.toFixed(1)} H ${targetX.toFixed(1)}`;
  });
  return { height, tops, paths };
}

/** Keep each explanation beside its source page and measure its connector after text and images have laid out. */
function GradedHomeworkPage({ page, items: sourceItems, caption, studentName, activeItemId, international, onFocus }: {
  page: HomeworkSubmission["pages"][number]; items: GradingItem[]; caption: string; studentName: string;
  activeItemId: string; international: boolean; onFocus(item: GradingItem): void;
}) {
  const items = useMemo(() => sourceItems.map(item => item.bbox ? { ...item, bbox: rotateNormalizedBox(item.bbox, page.rotation) } : item), [sourceItems, page.rotation]);
  const frame = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ height: number; tops: number[]; paths: string[] }>({ height: 0, tops: [], paths: [] });
  const callouts = items.flatMap(item => {
    if (item.requiresReview || !["incorrect", "partial"].includes(item.verdict) || !item.bbox) return [];
    const errors = [...(item.bbox.errors ?? [])];
    if (!errors.length && item.feedback) errors.push({ ...item.bbox, reason: item.feedback });
    return errors.map((error, index) => ({ item, error, index, markerId: item.bbox!.errors?.length ? `error-${item.id}-${index}` : `marker-${item.id}` }));
  })
    .sort((a, b) => a.error.y + a.error.height / 2 - b.error.y - b.error.height / 2);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let animation = 0;
    const measure = () => {
      const next = gradedPageLayout(element);
      if (next) setLayout(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const observer = new ResizeObserver(() => { cancelAnimationFrame(animation); animation = requestAnimationFrame(measure); });
    observer.observe(element);
    element.querySelectorAll(".graded-page>img,.error-callout").forEach(node => observer.observe(node));
    measure();
    return () => { observer.disconnect(); cancelAnimationFrame(animation); };
  }, [items]);

  return <figure id={`page-${page.id}`}><div ref={frame} className="annotated-homework-page" style={{ minHeight: layout.height || undefined }}>
    <aside className="error-reasons" aria-label={`${caption}的错误原因`}>{callouts.map(({ item, error, index, markerId }, position) =>
      <article id={`error-note-${item.id}-${index}`} data-marker-id={markerId} key={`${item.id}-${index}`} className={`error-callout${activeItemId === item.id ? " selected" : ""}`}
        style={{ top: layout.tops[position] ?? 0, visibility: layout.tops[position] == null ? "hidden" : undefined }}>
        <header><span className="grade-error-number">{item.questionNumber}{error.part}</span><b>错误原因</b></header>
        <p><MathText text={error.reason || "这处标记尚未补全错误原因。"} /></p>
      </article>)}</aside>
    <div className="graded-page">
      <HomeworkPageImage key={`${page.processedAssetId}-${page.rotation}`} page={page} alt={`${studentName}答卷${caption}`} />
      {items.filter(item => item.bbox).map(item => {
        const box = item.bbox!;
        const errors = !item.requiresReview && ["incorrect", "partial"].includes(item.verdict) ? box.errors ?? [] : [];
        const wrong = ["incorrect", "partial"].includes(item.verdict);
        const label = `查看${homeworkQuestionLabel(item.questionNumber)}${errors.length ? `，已标出 ${errors.length} 处错处` : wrong ? "，整题有错，具体位置待确认" : ""}`;
        return <button id={`marker-${item.id}`} key={item.id} className={`grade-marker ${!international && item.verdict === "partial" ? "incorrect" : item.verdict}${errors.length ? " has-errors" : ""}`} aria-pressed={activeItemId === item.id}
          style={{ left: `${box.x / 10}%`, top: `${box.y / 10}%`, width: `${box.width / 10}%`, height: `${box.height / 10}%` }} onClick={() => onFocus(item)} aria-label={label} title={label}>
          {errors.length ? errors.map((error, index) => <span id={`error-${item.id}-${index}`} key={index} className="grade-error" aria-hidden="true"
            style={{ left: `${(error.x - box.x) / box.width * 100}%`, top: `${(error.y - box.y) / box.height * 100}%`, width: `${error.width / box.width * 100}%`, height: `${error.height / box.height * 100}%` }} />)
            : wrong ? <span className="grade-unlocated" aria-hidden="true">{item.verdict === "partial" && international ? "△" : "×"}</span> : item.verdict === "correct" ? "✓" : "?"}
        </button>;
      })}
    </div>
    <svg className="error-connectors" aria-hidden="true" focusable="false">
      <defs><marker id={`error-arrow-${page.id}`} markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M 0 0 L 6 3 L 0 6 Z" fill="currentColor" /></marker></defs>
      {layout.paths.map((path, index) => <path key={index} d={path} fill="none" stroke="currentColor" strokeWidth="1.5" markerEnd={`url(#error-arrow-${page.id})`} />)}
    </svg>
  </div><figcaption>{caption}</figcaption></figure>;
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
          <div><HomeworkPageImage key={`${page.processedAssetId}-${page.rotation}`} page={page} alt={`第 ${page.pageOrder + 1} 页`} loading="lazy" />{marks.filter((item) => item.bbox).map((item) => {
            const box = rotateNormalizedBox(item.bbox!, page.rotation);
            return <i key={item.id} className={`tile-mark ${resultState(item, international)}`} style={{ left: `${(box.x + box.width / 2) / 10}%`, top: `${(box.y + box.height / 2) / 10}%` }} />;
          })}</div>
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
  const [split, setSplit] = useState(70);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ text: "", tone: "success" as "success" | "error" });
  const [loading, setLoading] = useState(true);
  const orientationRequests = useRef(new Set<string>());
  const [orienting, setOrienting] = useState(0);

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

  const gradingUploads = Boolean(submission && (["submitted", "processing"].includes(submission.status)
    || submission.assigned?.uploads.some(upload => ["submitted", "processing"].includes(upload.status))));
  useEffect(() => {
    if (!submission || !gradingUploads) return;
    const timer = setInterval(() => { void load(submission.id).catch(()=>{}); }, 4000);
    return () => clearInterval(timer);
  }, [submission?.id, gradingUploads]);

  useEffect(() => {
    for (const upload of [submission, ...dayEvidence?.uploads ?? []]) {
      if (!upload || !upload.pages.some(page => page.rotation == null)) continue;
      const key = `${upload.id}:${upload.pages.map(page => `${page.id}:${page.processedAssetId}`).join(",")}`;
      if (orientationRequests.current.has(key)) continue;
      orientationRequests.current.add(key);
      setOrienting(count => count + 1);
      void homeworkApi.updateSubmission(upload.id, { action: "orient-pages" }).then(({ submission: checked }) => {
        const apply = (current: HomeworkSubmission) => current.id !== checked.id ? current : { ...current, pages: current.pages.map(page => {
          const found = checked.pages.find(candidate => candidate.id === page.id && candidate.processedAssetId === page.processedAssetId);
          return found ? { ...page, rotation: found.rotation } : page;
        }) };
        // Only display metadata changes; a poll, replacement or unsaved judgment edit keeps its current data.
        setSubmission(current => current && apply(current));
        setDayEvidence(current => current && { ...current, uploads: current.uploads.map(apply) });
      }).catch(error => setMessage({ text: error instanceof Error ? error.message : "图片方向检查失败，请刷新后重试", tone: "error" }))
        .finally(() => setOrienting(count => count - 1));
    }
  }, [submission, dayEvidence]);

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
      const result = await homeworkApi.updateSubmission(submission.id, { action: "submit", autoMatch: (submission.assigned?.days.length ?? 0) > 1 });
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
    requestAnimationFrame(async () => {
      const page = document.getElementById(`page-${item.pageId}`);
      // Earlier pages determine this page's position; ignore an older selection if another question was clicked meanwhile.
      const images = Array.from(document.querySelectorAll<HTMLImageElement>("#review-originals .graded-page>img"));
      const last = images.findIndex(image => page?.contains(image));
      await Promise.all(images.slice(0, last + 1).map(image => image.decode().catch(() => {})));
      requestAnimationFrame(() => {
        if (!card?.classList.contains("selected")) return;
        if (window.matchMedia("(min-width:1001px)").matches) card.closest(".review-evidence-layout")?.scrollIntoView({ block: "start", behavior: "instant" });
        const marker = document.getElementById(`marker-${item.id}`);
        const notes = page?.querySelectorAll<HTMLElement>(`[id^="error-note-${item.id}-"]`) ?? [];
        for (const target of [marker ?? page, card]) {
          const pane = target?.closest<HTMLElement>(".review-pages,.grading-list");
          if (pane && target) {
            const offset = target === marker
              ? Math.max(target.getBoundingClientRect().bottom, ...Array.from(notes, note => note.getBoundingClientRect().bottom)) - pane.getBoundingClientRect().top - pane.clientHeight + 12
              : target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12;
            pane.scrollTo({ top: pane.scrollTop + offset, behavior: "instant" });
          }
        }
      });
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
      setMessage({ text: result.submission.failureReason || "判定已修正，错题本和作业报告已同步更新", tone: result.submission.failureReason ? "error" : "success" });
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
      setMessage({ text: result.failureReason || "结果已同步发布", tone: result.failureReason ? "error" : "success" });
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

  async function exportHomework(questions: Question[], kind: "word" | "pdf", includeAnalysis = false) {
    if (!submission || busy || !questions.length) return;
    const format = kind === "word" ? "Word" : "PDF";
    const content = includeAnalysis ? "作业解析" : "当前错题";
    setBusy(true); setMessage({ text: `正在导出${content} ${format}…`, tone: "success" });
    try {
      const title = [includeAnalysis ? "" : submission.studentName, titleWithoutStudent(submission.assignmentTitle, submission.studentName), content].filter(Boolean).join("-");
      let issues = 0;
      if (kind === "word") {
        const { buildQuestionsWordBlob, buildWordBlob, downloadWordBlob } = await import("../../../../../lib/export-word");
        downloadWordBlob(includeAnalysis ? await buildWordBlob({ title, sections: [{ questions }], answers: "each" })
          : await buildQuestionsWordBlob(questions, title, false, "basket"), `${title}.docx`);
      } else {
        const { buildHandoutLatexProject, compileLatexPdf, latexCompilerStatus } = await import("../../../../../lib/handout-latex-files");
        if (!(await latexCompilerStatus()).available) throw new Error("当前服务无法生成 PDF，请使用本地 MathPilot 导出。");
        const project = await buildHandoutLatexProject({ title, sheet: includeAnalysis ? "作业解析" : "错题练习", questions, answers: includeAnalysis ? "each" : "none" });
        if (project.missingFigures) throw new Error(`${project.missingFigures} 张配图读取失败，请重试导出`);
        const result = await compileLatexPdf(project);
        issues = result.issues;
        saveBlob(result.pdf, `${title}.pdf`);
      }
      setMessage({ text: `${includeAnalysis ? `已导出整份作业 ${questions.length} 道题的答案与解析` : `已导出 ${questions.length} 道当前错题`}（${format}${includeAnalysis ? "" : "，不含答案"}）${issues ? `，${issues} 处公式需要检查` : ""}`, tone: issues ? "error" : "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : `${content}导出失败，请重试`, tone: "error" }); }
    finally { setBusy(false); }
  }

  async function refresh() {
    setBusy(true);
    try { await load(); setMessage({ text: "状态已刷新", tone: "success" }); }
    finally { setBusy(false); }
  }

  async function exportGrading(scope?: number | "all") {
    if (!submission || busy || editingId) return;
    let exportHost: HTMLDivElement | undefined;
    let exportRoot: import("react-dom/client").Root | undefined;
    let scopeName = dayTask ? dayTask.title || `第${selectedDay! + 1}天` : `第${submission.version}次上传`;
    setBusy(true); setMessage({ text: "正在导出批改 PDF…", tone: "success" });
    try {
      const [{ drawPage }, { fileToDataUrl }, { compileLatexPdf, latexCompilerStatus }] = await Promise.all([
        import("../../../../../lib/file-import"), import("../../../../../lib/image-tools"), import("../../../../../lib/handout-latex-files"),
      ]);
      if (!(await latexCompilerStatus()).available) throw new Error("当前服务无法生成 PDF，请使用本地 MathPilot 导出。");
      let figures = Array.from(document.querySelectorAll<HTMLElement>("#review-originals>figure"));
      if (scope != null && submission.assigned) {
        // Export the chosen days' latest evidence, independently of the upload/day currently on screen.
        const sheet = (await homeworkApi.submission(submission.id)).submission.assigned;
        if (!sheet) throw new Error("打卡作业读取失败，请刷新后重试");
        let from = 0;
        const days = sheet.days.map((day, index) => {
          const questions = sheet.questions.slice(from, from + day.size); from += day.size;
          return { title: day.title || `第 ${index + 1} 天`, index, questions };
        }).filter(day => scope === "all" || day.index === scope);
        scopeName = scope === "all" ? "全部天数" : days[0]?.title ?? "当天";
        setMessage({ text: `正在读取${scopeName}的批改记录…`, tone: "success" });
        const questions = days.flatMap(day => day.questions);
        const ids = [...new Set(questions.flatMap(question => question.result ? [question.result.submissionId] : []))];
        const uploads = await Promise.all(ids.map(async uploadId => {
          let upload = (await homeworkApi.submission(uploadId)).submission;
          if (upload.pages.some(page => page.rotation == null)) upload = (await homeworkApi.updateSubmission(uploadId, { action: "orient-pages" })).submission;
          return upload;
        }));
        const latestItems = questions.flatMap(question => {
          if (!question.result) return [];
          const upload = uploads.find(upload => upload.id === question.result!.submissionId);
          const item = upload?.gradingItems.find(item => item.assignmentQuestionId === question.id);
          if (!item || !upload?.pages.some(page => page.id === item.pageId)) throw new Error("部分题目的原卷批改读取不完整，请刷新后重试");
          return [item];
        });
        const pages = uploads.flatMap(upload => upload.pages.flatMap(page => {
          const items = latestItems.filter(item => item.pageId === page.id);
          if (!items.length) return [];
          const pageDays = days.filter(day => day.questions.some(question => items.some(item => item.assignmentQuestionId === question.id)));
          return [{ page, items, day: pageDays[0].index, version: upload.version,
            caption: `${pageDays.map(day => day.title).join("、")} · 第 ${upload.version} 次上传 · 第 ${page.pageOrder + 1} 页` }];
        })).sort((a, b) => a.day - b.day || a.version - b.version || a.page.pageOrder - b.page.pageOrder);
        if (!pages.length) throw new Error(`${scopeName}暂无可导出的原卷批改`);
        if (pages.some(({ page }) => page.rotation == null)) throw new Error("图片方向检查尚未完成，请稍后重试导出");
        // Reuse the on-screen annotations, including pixel rotation, without changing the user's current view.
        const [{ createRoot }, { flushSync }] = await Promise.all([import("react-dom/client"), import("react-dom")]);
        exportHost = document.createElement("div"); exportHost.className = "review-shell review-pages";
        exportHost.setAttribute("aria-hidden", "true"); exportHost.inert = true;
        Object.assign(exportHost.style, { position: "fixed", left: "-12000px", top: "0", width: "800px", maxWidth: "none", display: "block" });
        document.body.appendChild(exportHost);
        exportRoot = createRoot(exportHost);
        flushSync(() => exportRoot!.render(<>{pages.map(({ page, items, caption }) => <GradedHomeworkPage key={page.id} page={page} items={items}
          caption={caption} studentName={submission.studentName} activeItemId="" international={international} onFocus={() => {}} />)}</>));
        figures = Array.from(exportHost.querySelectorAll<HTMLElement>(":scope>figure"));
      }
      if (!figures.length) throw new Error("当前暂无可导出的原卷批改");
      await Promise.all(figures.flatMap(figure => Array.from(figure.querySelectorAll("img"), async image => {
        // Rotation replaces src after the first load, so wait for that render before the final decode.
        try { await image.decode(); } catch { /* A src change can interrupt decoding; validate the final image below. */ }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (image.dataset.orienting) throw new Error("图片方向正在纠正，请稍后再导出");
        try { await image.decode(); } catch { throw new Error("原卷图片读取失败，请刷新页面后重试导出"); }
      })));
      await document.fonts.ready;
      // SVG snapshots cannot load external fonts. Embed the same KaTeX faces already used by the notes.
      const loadedFonts = new Set(Array.from(document.fonts).filter(font => font.status === "loaded").map(font => font.family.replaceAll('"', "")));
      const fontRules = Array.from(document.styleSheets).flatMap(sheet => {
        try { return Array.from(sheet.cssRules).filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule && loadedFonts.has(rule.style.fontFamily.replaceAll('"', "")) && /KaTeX/.test(rule.style.fontFamily)); }
        catch { return []; }
      });
      const fonts = (await Promise.all(fontRules.map(async rule => {
        const source = /url\(["']?([^"')]+)/.exec(rule.style.getPropertyValue("src"))?.[1];
        if (!source) throw new Error("公式字体读取失败，请刷新页面后重试导出");
        const response = await fetch(new URL(source, rule.parentStyleSheet?.href || document.baseURI));
        if (!response.ok) throw new Error("公式字体读取失败，请刷新页面后重试导出");
        const blob = await response.blob();
        const data = await fileToDataUrl(new File([blob], "font", { type: blob.type }));
        return `@font-face{font-family:${rule.style.fontFamily};font-style:${rule.style.fontStyle};font-weight:${rule.style.fontWeight};src:url("${data}")}`;
      }))).join("\n");
      // Let the existing page component finish measuring notes and connectors, including off-screen pages.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const files: Record<string, Uint8Array> = {};
      const pages: string[] = [];
      for (const [index, figure] of figures.entries()) {
        setMessage({ text: `正在导出批改 PDF（${index + 1}/${figures.length} 页）…`, tone: "success" });
        const width = 800;
        // A fixed print width keeps notes readable on A4 regardless of the viewport, splitter or zoom.
        const host = document.createElement("div"); host.className = "review-shell review-pages"; host.setAttribute("aria-hidden", "true");
        host.inert = true;
        Object.assign(host.style, { position: "fixed", left: "-12000px", top: "0", width: `${width}px`, maxWidth: "none", display: "block", margin: "0", padding: "0", color: "#24352f" });
        const clone = figure.cloneNode(true) as HTMLElement;
        Object.assign(clone.style, { width: `${width}px`, margin: "0" });
        for (const [name, value] of Object.entries({ "--page": "#f5f7f4", "--surface": "#fff", "--ink": "#24352f", "--muted": "#61706a", "--line": "#e4e9e6", "--danger-soft": "#fff0e8", "--danger": "#a34f39" })) clone.style.setProperty(name, value);
        clone.querySelectorAll(".selected").forEach(node => node.classList.remove("selected"));
        clone.querySelectorAll(".katex-mathml").forEach(node => node.remove());
        // Browser SVG snapshots otherwise paint horizontal scrollbars over radical formulas.
        clone.querySelectorAll<HTMLElement>(".math-formula").forEach(formula => { formula.style.overflow = "visible"; });
        clone.querySelectorAll(".grade-marker").forEach(node => node.setAttribute("aria-pressed", "false"));
        clone.querySelectorAll<SVGElement>(".error-connectors").forEach(svg => { svg.style.color = "#c44e43"; });
        for (const image of clone.querySelectorAll("img")) {
          const response = await fetch(image.src);
          if (!response.ok) throw new Error("原卷图片读取失败，请刷新页面后重试导出");
          const blob = await response.blob();
          image.src = await fileToDataUrl(new File([blob], "page", { type: blob.type }));
          await image.decode();
        }
        const caption = clone.querySelector("figcaption");
        if (caption) caption.textContent = `${submission.studentName} · ${titleWithoutStudent(submission.assignmentTitle, submission.studentName)} · ${caption.textContent}`;
        const style = document.createElement("style"); style.textContent = fonts; clone.prepend(style);
        host.appendChild(clone); document.body.appendChild(host);
        let canvas: HTMLCanvasElement;
        try {
          const frame = clone.querySelector<HTMLElement>(".annotated-homework-page")!;
          const layout = gradedPageLayout(frame);
          if (!layout) throw new Error("原卷批注尚未准备好，请刷新页面后重试导出");
          frame.style.minHeight = `${layout.height}px`;
          frame.querySelectorAll<HTMLElement>(".error-callout").forEach((note, index) => { note.style.top = `${layout.tops[index]}px`; note.style.visibility = "visible"; });
          frame.querySelectorAll(".error-connectors>path").forEach((path, index) => path.setAttribute("d", layout.paths[index]));
          canvas = await drawPage(clone, 3, host.className);
        }
        finally { host.remove(); }
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("原卷页面生成失败，请重试导出")), "image/jpeg", .95));
        const name = `page-${index + 1}.jpg`;
        files[name] = new Uint8Array(await blob.arrayBuffer());
        pages.push(`\\noindent\\includegraphics[width=\\linewidth,height=.99\\textheight,keepaspectratio]{${name}}`);
        canvas.width = 0; canvas.height = 0;
      }
      const main = "grading.tex";
      files[main] = new TextEncoder().encode([
        "\\documentclass{article}", "\\usepackage[a4paper,margin=5mm]{geometry}", "\\usepackage{graphicx}",
        "\\pagestyle{empty}", "\\setlength{\\parindent}{0pt}", "\\begin{document}", pages.join("\n\\newpage\n"), "\\end{document}",
      ].join("\n"));
      const { pdf } = await compileLatexPdf({ main, files, missingFigures: 0 });
      const name = `${submission.studentName}-${titleWithoutStudent(submission.assignmentTitle, submission.studentName)}-${scopeName}-批改.pdf`.replace(/[\\/:*?"<>|]/g, "_");
      saveBlob(pdf, name);
      setMessage({ text: `已导出${scopeName}的批改 PDF，共 ${figures.length} 页，包含原卷、批改标记和错误原因`, tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "批改导出失败，请重试", tone: "error" }); }
    finally { exportRoot?.unmount(); exportHost?.remove(); setBusy(false); }
  }

  if (loading) return <><SiteHeader active="students" user={user ?? null} loading={user === undefined} trail={[{label:"学生档案",href:"/library?view=wrong-book"},{label:"批改详情"}]} /><main className="homework-loading">正在读取学生作业…</main></>;
  if (!submission) return <><SiteHeader active="students" user={user ?? null} loading={user === undefined} trail={[{label:"学生档案",href:"/library?view=wrong-book"},{label:"批改详情"}]} /><main className="homework-loading"><p>{message.text || "提交记录不存在"}</p><a href="/tools/homework">返回作业批改</a></main></>;

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
  const archiveLink = `/library?view=wrong-book&studentId=${encodeURIComponent(submission.studentId)}`;
  const canExportGrading = !!evidencePages.length && evidencePages.every(page => page.rotation != null) && !!evidenceItems.length && (Boolean(dayTask) || ["review_required", "ready", "published"].includes(submission.status));
  const gradingExport = assigned && assigned.days.length > 1 ? <select className="secondary" aria-label="导出批改" defaultValue=""
    disabled={busy || !!editingId || !assigned.questions.some(question => question.result)}
    title={editingId ? "请先保存或取消判定修正" : "选择某一天或全部天数，导出各题最新的原卷批改（PDF）"}
    onChange={event => { const scope = event.currentTarget.value; event.currentTarget.value = ""; if (scope) void exportGrading(scope === "all" ? "all" : Number(scope)); }}>
    <option value="" disabled>导出批改</option><option value="all">全部批改（所有天数）</option>
    {assigned.days.map((day, index) => {
      const from = assigned.days.slice(0, index).reduce((sum, entry) => sum + entry.size, 0);
      const available = assigned.questions.slice(from, from + day.size).some(question => question.result);
      return <option key={index} value={index} disabled={!available}>{day.title || `第 ${index + 1} 天`}{available ? "" : "（暂无批改）"}</option>;
    })}
  </select> : <button type="button" disabled={busy || !!editingId || !canExportGrading} onClick={() => void exportGrading()}
    title={editingId ? "请先保存或取消判定修正" : evidencePages.some(page => page.rotation == null) ? "图片方向检查尚未完成，请稍后再导出；检查失败时请刷新重试" : canExportGrading ? `导出下方原卷标记的全部 ${evidencePages.length} 页，包含批改痕迹和错误原因（PDF）` : "当前暂无可导出的原卷批改"}>导出批改</button>;
  const overview = <><div><span className={`review-status ${submission.status}`}>{status}</span><h1>{titleWithoutStudent(submission.assignmentTitle, submission.studentName)} · {submission.studentName}</h1>{submission.submittedAt != null && <p>提交日期：{new Date(submission.submittedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }).replaceAll("/", ".")}</p>}</div>
      {!live && marks && <div className="review-score" aria-label="得分"><b>{marks.score}</b><span>/ {marks.maxScore}</span><small>{marks.percentage == null ? `${marks.pending} 题待定分` : `${marks.percentage}%`}</small></div>}
      {!assigned && <div className="review-outputs" role="group" aria-label="这份作业写到了哪里">
        {submission.outputs.wrongBook && <div><span>写入错题本</span><a href={archiveLink}>已归档错题 {summary?.archived ?? 0} 道 →</a></div>}
        <label><input type="checkbox" role="switch" aria-label="计入定档" checked={submission.outputs.profile} disabled={busy || live || submission.status === "ready"}
          onChange={(event) => void changeProfile(event.target.checked)} /><span>计入定档</span></label>
        {(live || submission.status === "ready") && <small>批改发布完成后可以切换</small>}
      </div>}</>;
  return <><SiteHeader active="students" user={user ?? null} loading={user === undefined}
    trail={[{label:"学生档案",href:"/library?view=wrong-book"},{label:submission.studentName,href:`${archiveLink}&tab=homework`},{label:titleWithoutStudent(submission.assignmentTitle, submission.studentName)}]}
    trailActions={<>{submission.outputs.report && international && report?.details && <button className="secondary" disabled={busy} onClick={() => downloadReport("pdf")}>下载批改报告</button>}<PaperMoreMenu label="作业维护操作"><button disabled={busy} onClick={refresh}>刷新</button>{!assigned && ["published","ready"].includes(submission.status) && <button onClick={attachFigures} disabled={busy}>校对原卷配图{submission.figuresPending ? `（${submission.figuresPending}题待核对）` : ""}</button>}{submission.status === "published" && !assigned && <button disabled={busy} onClick={() => void newVersion({}, "上传新版本")}>上传新版本</button>}{submission.outputs.report && international && report?.details && <button disabled={busy} onClick={() => downloadReport("tex")}>下载 TeX</button>}</PaperMoreMenu></>} /><main className="review-shell">
    {message.text && <div className={`homework-notice${message.tone === "error" ? " inline-error" : ""}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}<button onClick={() => setMessage({ text: "", tone: "success" })} aria-label="关闭提示">×</button></div>}
    <section className="homework-panel review-overview" aria-label="作业概览">

    {assigned ? <AssignedHomeworkSheet submission={{ ...submission, assigned }} busy={busy} selectedDay={selectedDay} actions={gradingExport} onExport={(questions, kind, includeAnalysis) => void exportHomework(questions, kind, includeAnalysis)}
      onDay={(day) => { setSelectedDay(day); setEditingId(""); setActiveItemId(""); requestAnimationFrame(() => document.getElementById("day-results")?.scrollIntoView({ block: "start", behavior: "instant" })); }}
      onContinue={() => {
        if (submission.status === "draft" && !submission.questionScope?.length) {
          setSelectedDay(null);
          requestAnimationFrame(() => document.querySelector(".review-upload")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }));
        } else void newVersion({}, "上传作业或订正");
      }}
      onCorrect={(day) => void newVersion({ correctionDay: day }, assigned.days.length > 1 ? `订正第 ${day + 1} 天的错题` : "订正错题")}
      onFocus={(questionId) => {
        const item = evidenceItems.find((entry) => entry.assignmentQuestionId === questionId) ?? items.find((entry) => entry.assignmentQuestionId === questionId);
        if (!item) return;
        if (!evidenceItems.includes(item)) { setSelectedDay(null); requestAnimationFrame(() => focusEvidence(item, true)); }
        else focusEvidence(item, true);
      }}>{overview}</AssignedHomeworkSheet> : <section className="review-summary">{overview}<div className="assigned-sheet-actions">{gradingExport}</div></section>}
    </section>
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


    {!dayTask && submission.status === "draft" && <section className="review-upload"><div><h2>{assigned && assigned.days.length > 1 ? "上传作业 / 订正" : correctionQuestions.length ? "上传错题订正" : scoped.length ? `上传${uploadDay?.title || "这一天"}的作业` : "上传学生作业"}</h2><p>{assigned && assigned.days.length > 1 ? "可一次上传不同天的作业和订正照片或 PDF，无需选择天数。优先按题目 ID 匹配，缺少 ID 时核对题干，自动归到对应天并批改；本次没有上传的题目保留原结果。" : correctionQuestions.length ? `本次订正：${correctionQuestions.map((question) => homeworkQuestionLabel(question.number)).join("、")}。上传订正照片或 PDF，只更新本次找到的错题，其他题保留原状态。` : scoped.length ? `本次只批改这一天还没交的 ${scoped.length} 道题：${scoped.map((question) => homeworkQuestionLabel(question.number)).join("、")}。` : assigned ? "学生拍好的照片或 PDF，可以只传交来的部分，按这份作业的题目清单批改，没交的题之后再传。" : "看不清的题目单独待处理，其余正常批改。"}</p></div><HomeworkPagePicker pages={pages} onChange={setPages} disabled={busy} onSourceFile={file=>setSourceDocuments(current=>[...current,file])} />{!assigned && <details className="completed-reference"><summary>参考答案（选填）</summary><input aria-label="补充参考答案" type="file" multiple accept="image/*,application/pdf" onChange={e=>setReferenceFiles([...(e.target.files??[])])} /></details>}<button className="primary upload-submit" disabled={busy || !pages.length} onClick={uploadAndSubmit}>{busy ? "正在上传…" : `提交 ${pages.length} 页${correctionQuestions.length ? "订正" : "作业"}`}</button></section>}


    {!dayTask && ["review_required", "ready"].includes(submission.status) && <section className="legacy-result-banner"><div><b>{submission.failureReason.startsWith("修正已保存") ? "修正已保存，结果同步待完成" : "这是启用自动发布前产生的旧提交"}</b><p>{submission.failureReason || "保留旧流程兼容，不会被后台自动发布。"}</p></div><button className="primary" onClick={finishLegacySubmission} disabled={busy}>{submission.failureReason.startsWith("修正已保存") ? "重试同步" : "确认并发布"}</button></section>}

    {(dayTask || ["review_required", "ready", "published"].includes(submission.status)) && <>
      {!dayTask && submission.outputs.report && international && report?.details && <section className="diagnosis-grid"><InternationalReportCard report={report.details} /></section>}
      {!dayTask && submission.outputs.report && !international && <section className="diagnosis-grid">
        <article className="submission-report-card"><header><span>整份诊断</span><h2>{report?.overallSummary || "逐题结果已完成"}</h2><p>{report?.studentMessage || "当前提交尚未生成整份建议。"}</p></header>{report && <><div className="report-columns"><section><b>做得好的地方</b>{report.strengths.length ? report.strengths.map((point) => <div key={`${point.title}-${point.questionNumbers.join("-")}`}><strong>{point.title}</strong><p>{point.detail}</p><small>{point.questionNumbers.map(homeworkQuestionLabel).join("、")}</small></div>) : <p className="report-empty">本次暂无足够证据。</p>}</section><section><b>优先改进</b>{report.gaps.length ? report.gaps.map((point) => <div key={`${point.title}-${point.questionNumbers.join("-")}`}><strong>{point.title}</strong><p>{point.detail}</p><small>{point.questionNumbers.map(homeworkQuestionLabel).join("、")}</small></div>) : <p className="report-empty">暂未发现优先问题。</p>}</section></div><section className="report-actions"><b>下一步建议</b><ol>{report.actions.map((action) => <li key={action}>{action}</li>)}</ol></section></>}</article>
      </section>}

      {!!evidencePages.length && <section className="review-evidence-layout" style={{ "--review-split": `${split}%` } as CSSProperties}>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll this region independently. */}
        <div className="review-pages" id="review-originals" role="region" aria-label="原卷标记，独立滚动" tabIndex={0}>
        <div className="review-pages-heading"><h2>原卷标记</h2>{orienting > 0 && <small role="status">正在自动检查图片方向…</small>}</div>
        {evidencePages.map(page => <GradedHomeworkPage key={page.id} page={page} items={evidenceItems.filter(item => item.pageId === page.id)}
          caption={`${dayTask ? `第 ${assigned!.uploads.find(upload => upload.id === page.submissionId)?.version} 次上传 · ` : ""}第 ${page.pageOrder + 1} 页`}
          studentName={submission.studentName} activeItemId={activeItemId} international={international} onFocus={item => focusEvidence(item, true)} />)}
      </div>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- A focusable ARIA window splitter supports pointer and keyboard resizing. */}
        <div className="review-splitter" role="separator" aria-label="调整原卷与解析宽度" aria-orientation="vertical" aria-valuemin={55} aria-valuemax={80} aria-valuenow={split} aria-controls="review-originals review-details" tabIndex={0}
          onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = event.currentTarget.parentElement!.getBoundingClientRect(); setSplit(Math.max(55, Math.min(80, Math.round((event.clientX - box.left) / box.width * 100)))); }}
          onPointerUp={event => { if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId); }}
          onDoubleClick={() => setSplit(70)}
          onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); setSplit(current => event.key === "Home" ? 55 : event.key === "End" ? 80 : Math.max(55, Math.min(80, current + (event.key === "ArrowLeft" ? -2 : 2)))); }} />
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll this region independently. */}
        <div className="grading-list" id="review-details" role="region" aria-label="逐题详情，独立滚动" tabIndex={0}><div className="grading-heading"><div><h2>逐题证据</h2><p>展开题目查看参考答案与解析。</p></div></div>{evidenceItems.map((item) => {
          const editing = editingId === item.id;
          return <details id={`grading-${item.id}`} key={item.id} name="grading-evidence" className={`grading-card compact ${!international && item.verdict === "partial" ? "incorrect" : item.verdict}${activeItemId === item.id ? " selected" : ""}`} open={editing || undefined}><summary onClick={() => focusEvidence(item)}><span>{homeworkQuestionLabel(item.questionNumber)}</span><b>{verdictLabel(item, international)}</b>{dayTask && <small>第 {assigned!.uploads.find((upload) => upload.id === item.submissionId)?.version} 次上传</small>}{item.teacherMark && <small>老师批改</small>}</summary><div className="grading-detail">{international && <p className="grading-stem"><MathText text={item.stem} /></p>}{international && !!item.figures?.length && <div className="grading-figures">{item.figures.map((figure, index) => <img key={figure.url} className={figure.kind} src={figure.url} alt={`${homeworkQuestionLabel(item.questionNumber)}配图 ${index + 1}`} loading="lazy" />)}</div>}{editing ? <><div className="grading-fields"><label>批改结论<select value={item.verdict} onChange={(event) => updateItem(item.id, reconcileHomeworkScore(event.target.value as GradingItem["verdict"], null, item.maxScore, submission.curriculum))}><option value="correct">正确</option><option value="incorrect">错误</option>{!binary && <><option value="partial">部分正确</option><option value="unreadable">{international ? "看不清（0 分）" : "待补图"}</option><option value="review_required">待核实</option></>}</select></label><label>错误类型<input value={item.errorType} onChange={(event) => updateItem(item.id, { errorType: event.target.value })} placeholder="计算、审题、步骤…" /></label>{!binary && <label>满分<input type="number" min={0} step={0.5} inputMode="decimal" value={item.maxScore ?? ""} onChange={(event) => { const maxScore = event.target.value === "" ? null : Number(event.target.value); updateItem(item.id, { maxScore, ...reconcileHomeworkScore(item.verdict, item.score, maxScore, submission.curriculum) }); }} placeholder="原卷无分值可留空" /></label>}{!binary && item.maxScore != null && <label>得分<input type="number" min={0} max={item.maxScore} step={0.5} inputMode="decimal" value={item.score ?? ""} onChange={(event) => updateItem(item.id, event.target.value === "" ? { score: null } : reconcileHomeworkScore("partial", event.target.value, item.maxScore))} /></label>}</div><label>题干<textarea rows={3} value={item.stem} onChange={event=>updateItem(item.id,{stem:event.target.value})} /></label><label>参考答案<input value={item.standardAnswer} onChange={event=>updateItem(item.id,{standardAnswer:event.target.value})} /></label><label>参考解析<textarea rows={3} value={item.standardAnalysis} onChange={event=>updateItem(item.id,{standardAnalysis:event.target.value})} /></label><label><input type="checkbox" checked={item.referenceVerified === true} onChange={event=>updateItem(item.id,{referenceVerified:event.target.checked})} />我已核实题目与参考解答</label><label>学生作答<textarea rows={2} value={item.studentAnswer} onChange={(event) => updateItem(item.id, { studentAnswer: event.target.value })} /></label><label>给学生的反馈<textarea rows={3} value={item.feedback} onChange={(event) => updateItem(item.id, { feedback: event.target.value })} /></label><div className="correction-actions"><button onClick={() => { setEditingId(""); void load(submission.id); }}>取消</button><button className="primary" onClick={() => saveCorrection(item)} disabled={busy}>保存修正</button></div></> : <>{international && item.stepAnalysis.length > 0 && <div className="step-analysis"><b>步骤分析</b><ol>{item.stepAnalysis.map((step) => <li key={step}>{step}</li>)}</ol></div>}{(item.standardAnswer || item.standardAnalysis) && <div className="standard-answer"><b>参考答案 · {item.referenceSource === "agent" ? "独立解题" : item.referenceSource === "unresolved" ? "待校验" : item.referenceEvidence === "题库原题答案" ? "题库答案" : item.referenceEvidence === "布置时资料自带的答案" ? "资料自带答案" : "教师提供"}</b>{item.standardAnswer && <p><MathText text={item.standardAnswer} /></p>}{item.standardAnalysis && <small><MathText text={item.standardAnalysis} /></small>}</div>}{international && (item.evidenceSummary || item.feedback || item.errorType) && <div className="evidence-feedback"><b>判定依据与反馈</b><p>{[item.evidenceSummary, item.feedback].filter(Boolean).join("。")}</p>{item.errorType && <small>问题标签：{item.errorType}</small>}</div>}{!item.standardAnswer && !item.standardAnalysis && <p className="reference-empty">{item.teacherMark === "correct" ? "老师已判为正确，无需补充参考答案。" : item.referenceEvidence || item.feedback || "参考答案待补全，可在上方待处理区重新处理。"}</p>}{(dayTask || submission.status === "published") && <button className="quiet-correction" onClick={() => dayTask ? location.assign(`/tools/homework/submissions/${encodeURIComponent(item.submissionId)}#grading-${item.id}`) : setEditingId(item.id)}>{dayTask ? "去原上传修正判定" : "修正判定"}</button>}</>}</div></details>;
        })}</div>
      </section>}
    </>}
    {!dayTask && !!submission.questionOriginals?.length && <details className="homework-panel review-archive-panel"><summary>学校作业原件（{submission.questionOriginals.length} 页）</summary><div className="original-files">{submission.questionOriginals.map((document,index)=><a key={document.url} className="original-file" href={document.url} target="_blank" rel="noreferrer"><img src={document.url} alt=""/><span><b>{document.name}</b><small>第 {index+1} 页 · 点击在新窗口打开</small></span></a>)}</div></details>}
    {!dayTask && !!submission.pageRevisions?.length && <details className="homework-panel review-archive-panel"><summary>历史作业原件</summary>{submission.pageRevisions.map((revision,index)=><p key={index}><a href={revision.originalUrl} target="_blank" rel="noreferrer">补图前原件 · {new Date(revision.createdAt).toLocaleString("zh-CN")}</a></p>)}</details>}
  </main></>;
}
