"use client";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "./ConfirmDialog";
import { PaperMoreMenu } from "./PaperMoreMenu";
import { resizeStudioImage } from "../../lib/answer-studio-images";
import type { StudioJob, StudioJobKind } from "../../lib/server/answer-studio-jobs";
import "./recognition-jobs.css";

// Background recognition jobs: 文件转录 (transcription) and 题库 file imports (import) list, poll and act on
// their jobs here; each page keeps its own way of opening a finished one.

export async function jobsApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init), data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
  return data as T;
}
export const postJson = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
/** One page in source order: the full page for figures, and the copy the AI reads. */
export async function uploadJobPage(jobId: string, page: Record<string, unknown> & { image: string }) {
  const { image, ...meta } = page;
  await jobsApi(`/api/answer-studio/jobs/${jobId}/pages`, postJson({ page: meta, image, recognizeImage: await resizeStudioImage(image) }));
}
export async function jobPageImage(jobId: string, pageId: string, label: string) {
  const response = await fetch(`/api/answer-studio/jobs/${jobId}/pages/${encodeURIComponent(pageId)}`);
  if (!response.ok) throw new Error(`${label}原件读取失败`);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}

const words: Record<StudioJobKind, { title: string; running: string; cancel: string; work: string; removed: string }> = {
  transcription: { title: "转录任务", running: "转录中", cancel: "取消转录", work: "转录", removed: "原件和转录结果" },
  import: { title: "识别任务", running: "识别中", cancel: "取消识别", work: "识别", removed: "页面图片和识别结果" },
};
// Really in progress: the jobs the nav badges count, marked by a pulsing dot.
export const jobLive = (job: StudioJob) => (job.status === "queued" || job.status === "running") && !job.stalled;
function jobState(job: StudioJob, kind: StudioJobKind) {
  if (job.stalled) return "已中断";
  if (job.status === "uploading") return "上传未完成";
  if (job.status === "queued") return "排队中";
  if (job.status === "running") return `${words[kind].running} ${job.processedCount}/${job.pageCount} 页`;
  if (job.status === "done") return `已完成 · ${job.questionCount} 题`;
  return job.progress || "失败";
}
const jobTime = (value: number) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** One kind's jobs, polled every 3 seconds while one is moving, with the actions every row offers.
 * report shows an action's error (or clears it with ""); removed lets a page drop what it opened from that job. */
export function useRecognitionJobs(kind: StudioJobKind, enabled: boolean, report: (message: string) => void, removed?: (job: StudioJob) => void) {
  const [jobs, setJobs] = useState<StudioJob[]>([]), [cancellingJobId, setCancellingJobId] = useState("");
  const [confirmNode, confirm] = useConfirm();
  const refresh = useCallback(async () => { try { setJobs((await jobsApi<{ jobs: StudioJob[] }>(`/api/answer-studio/jobs?kind=${kind}`)).jobs); } catch { /* the list retries on the next poll */ } }, [kind]);
  const moving = jobs.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!enabled) return;
    const first = setTimeout(() => void refresh(), 0);
    const timer = moving ? setInterval(() => void refresh(), 3000) : undefined;
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [enabled, moving, refresh]);
  async function resume(job: StudioJob) {
    try { await jobsApi(`/api/answer-studio/jobs/${job.id}`, { method: "POST" }); report(""); await refresh(); }
    catch (error) { report(error instanceof Error ? error.message : "继续失败"); }
  }
  async function cancel(job: StudioJob) {
    if (cancellingJobId) return;
    setCancellingJobId(job.id);
    try {
      const result = await jobsApi<{ job: StudioJob }>(`/api/answer-studio/jobs/${job.id}`, { method: "PATCH" });
      setJobs((current) => current.map((item) => item.id === job.id ? result.job : item)); report("");
    } catch (error) { report(error instanceof Error ? error.message : "取消失败"); }
    finally { setCancellingJobId(""); }
  }
  async function remove(job: StudioJob) {
    if (!await confirm({ title: `删除${words[kind].title}`, body: `「${job.title}」的${words[kind].removed}会从服务器删除，无法恢复。`, confirmLabel: "删除", danger: true })) return;
    try {
      await jobsApi(`/api/answer-studio/jobs/${job.id}`, { method: "DELETE" });
      removed?.(job); setJobs((current) => current.filter((item) => item.id !== job.id));
    } catch (error) { report(error instanceof Error ? error.message : "删除失败"); }
  }
  return { jobs, setJobs, refresh, resume, cancel, remove, cancellingJobId, confirmNode };
}

/** The job rows: state with a pulsing dot while really in progress, then 打开, 继续, ⋯ 删除 or 取消. */
export function RecognitionJobTable({ kind, jobs, openJobId = "", busy, cancellingJobId, canOpen, onOpen, onResume, onCancel, onRemove }: {
  kind: StudioJobKind; jobs: StudioJob[]; openJobId?: string; busy: boolean; cancellingJobId: string;
  canOpen: (job: StudioJob) => boolean; onOpen: (job: StudioJob) => void; onResume: (job: StudioJob) => void; onCancel: (job: StudioJob) => void; onRemove: (job: StudioJob) => void;
}) {
  if (!jobs.length) return null;
  const word = words[kind];
  return <section className="studio-jobs" aria-labelledby={`${kind}-jobs-title`}>
    <h2 id={`${kind}-jobs-title`}>{word.title}</h2>
    <table><tbody>{jobs.map((job) => <tr key={job.id} className={job.id === openJobId ? "current" : undefined}>
      <td className="job-title">{job.title}</td>
      <td className={`job-state${job.status === "failed" && job.error || job.stalled ? " danger-text" : ""}${jobLive(job) ? " live" : ""}`} title={job.error || job.progress || undefined}>{jobState(job, kind)}{job.stalled ? <small>可能因服务重启而中断，点继续从断点接着{word.work}</small> : job.status === "running" && job.progress ? <small>{job.progress}</small> : null}{job.status === "failed" && job.error ? <small>{job.error}</small> : null}</td>
      <td className="job-time">{jobTime(job.createdAt)}</td>
      <td className="job-actions">
        {canOpen(job) && <button type="button" className="text-button" disabled={busy || job.id === openJobId} onClick={() => onOpen(job)}>{job.id === openJobId ? "已打开" : "打开"}</button>}
        {(job.status === "failed" || job.stalled) && <button type="button" className="text-button" disabled={busy} onClick={() => onResume(job)}>继续</button>}
        {(job.stalled || job.status !== "queued" && job.status !== "running") && <PaperMoreMenu label={`这个${word.title}的操作`}><button type="button" className="danger-text" onClick={() => onRemove(job)}>删除…</button></PaperMoreMenu>}
        {(job.status === "queued" || job.status === "running") && <button type="button" disabled={busy || !!cancellingJobId} onClick={() => onCancel(job)}>{cancellingJobId === job.id ? "取消中…" : word.cancel}</button>}
      </td>
    </tr>)}</tbody></table>
  </section>;
}
