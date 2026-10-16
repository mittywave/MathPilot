import { env } from "cloudflare:workers";
import type { AuthUser } from "../types";
import { studioInputMode, type StudioDraft, type StudioPage, type StudioRecord } from "../answer-studio";
import { normalizeStudioRecords, studioRecognitionPrompt, studioRecognitionSchema } from "../answer-studio-contract";
import { StudioRequestError, studioConcurrency, studioUpstreamError } from "../answer-studio-concurrency";
import { transcribeStudio } from "../answer-studio-pipeline";
import { callRecognitionModel, parseRecognitionModelText } from "./recognition-model";

/** Text transcription runs here so it keeps going after the teacher leaves the page.
 * The browser renders and uploads pages, then later downloads the draft to draw figures and build Word. */
type StudioQueueMessage = { kind: "studio_transcription"; jobId: string };
type AppEnv = { DB: D1Database; HOMEWORK_ASSETS?: R2Bucket; HOMEWORK_GRADING_QUEUE?: { send(message: StudioQueueMessage): Promise<void> } };
export type StudioJobStatus = "uploading" | "queued" | "running" | "done" | "failed";
export type StudioJob = { id: string; title: string; status: StudioJobStatus; stalled: boolean; pageCount: number; processedCount: number; questionCount: number; progress: string; error: string; createdAt: number; updatedAt: number };
type JobRow = { id: string; owner_user_id: string; title: string; status: StudioJobStatus; run_id: string; text_concurrency: number; page_count: number; processed_count: number; question_count: number; progress: string; error: string; created_at: number; updated_at: number };

// The local queue delivers one batch at a time, so one long run would hold up homework grading.
// Each delivery works for about this long, then re-queues and resumes from its checkpoint.
const RUN_SLICE_MS = 2 * 60_000;
// A queued or running job with no update for this long has lost its worker, usually to a server restart.
const STALE_MS = 5 * 60_000;

function appEnv() { return env as unknown as AppEnv; }
function db() { return appEnv().DB; }
function bucket() {
  const value = appEnv().HOMEWORK_ASSETS;
  if (!value) throw new Response(JSON.stringify({ error: "转录原件存储尚未配置" }), { status: 503, headers: { "Content-Type": "application/json" } });
  return value;
}
const notFound = () => new Response(JSON.stringify({ error: "转录任务不存在" }), { status: 404, headers: { "Content-Type": "application/json" } });
const badRequest = (error: string) => new Response(JSON.stringify({ error }), { status: 400, headers: { "Content-Type": "application/json" } });
const PAGE_ID = /^[\w-]{1,80}$/;
const draftKey = (id: string) => `studio/${id}/draft.json`;
const imageKey = (id: string, pageId: string, kind: "full" | "recognize") => `studio/${id}/${pageId}.${kind}.jpg`;
const job = (row: JobRow): StudioJob => ({
  id: row.id, title: row.title, status: row.status,
  stalled: (row.status === "queued" || row.status === "running") && Date.now() - row.updated_at > STALE_MS,
  pageCount: row.page_count, processedCount: row.processed_count, questionCount: row.question_count, progress: row.progress, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
});

async function ownedRow(user: AuthUser, id: string) {
  const row = await db().prepare("SELECT * FROM studio_jobs WHERE id = ? AND owner_user_id = ?").bind(id, user.id).first<JobRow>();
  if (!row) throw notFound();
  return row;
}
async function readDraft(id: string) {
  const object = await bucket().get(draftKey(id));
  if (!object) throw new Error("转录草稿缺失");
  return await object.json<StudioDraft>();
}
async function writeDraft(id: string, draft: StudioDraft) {
  await bucket().put(draftKey(id), JSON.stringify({ ...draft, pages: draft.pages.map(page => ({ ...page, image: "" })) }), { httpMetadata: { contentType: "application/json" } });
}
function dataUrlBytes(value: unknown) {
  const match = typeof value === "string" && value.length <= 25_000_000 ? /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(value) : null;
  if (!match) throw badRequest("页面图片无效");
  return Uint8Array.from(atob(match[1]), char => char.charCodeAt(0));
}
function bytesDataUrl(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes); let text = "";
  for (let offset = 0; offset < view.length; offset += 0x8000) text += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  return `data:image/jpeg;base64,${btoa(text)}`;
}

export async function listStudioJobs(user: AuthUser) {
  const rows = await db().prepare("SELECT * FROM studio_jobs WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 50").bind(user.id).all<JobRow>();
  return rows.results.map(job);
}

export async function createStudioJob(user: AuthUser, input: { title?: unknown; textConcurrency?: unknown }) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > 200) throw badRequest("请填写资料名称");
  const id = crypto.randomUUID(), now = Date.now();
  const draft: StudioDraft = { version: 1, title, pages: [], questions: [], answers: [], updatedAt: now };
  await writeDraft(id, draft);
  await db().prepare("INSERT INTO studio_jobs (id, owner_user_id, title, status, text_concurrency, created_at, updated_at) VALUES (?, ?, ?, 'uploading', ?, ?, ?)")
    .bind(id, user.id, title, studioConcurrency(input.textConcurrency), now, now).run();
  return job(await ownedRow(user, id));
}

/** Pages arrive one at a time and in source order; the browser waits for each before sending the next. */
export async function addStudioJobPage(user: AuthUser, id: string, input: { page?: unknown; image?: unknown; recognizeImage?: unknown }) {
  const row = await ownedRow(user, id);
  if (row.status !== "uploading") throw badRequest("任务已开始，不能再添加页面");
  const page = input.page as Partial<StudioPage> | undefined;
  if (!page || typeof page.id !== "string" || !PAGE_ID.test(page.id) || (page.role !== "question" && page.role !== "answer") || typeof page.name !== "string" || !Number.isInteger(page.page) || typeof page.hash !== "string") throw badRequest("页面信息无效");
  const full = dataUrlBytes(input.image), recognize = dataUrlBytes(input.recognizeImage);
  const draft = await readDraft(id);
  if (draft.pages.some(item => item.role === page.role && item.hash === page.hash)) return job(row);
  await bucket().put(imageKey(id, page.id, "full"), full, { httpMetadata: { contentType: "image/jpeg" } });
  await bucket().put(imageKey(id, page.id, "recognize"), recognize, { httpMetadata: { contentType: "image/jpeg" } });
  draft.pages.push({ id: page.id, role: page.role, name: page.name.slice(0, 200), page: page.page!, hash: page.hash, image: "", selected: true });
  await writeDraft(id, draft);
  await db().prepare("UPDATE studio_jobs SET page_count = ?, updated_at = ? WHERE id = ?").bind(draft.pages.length, Date.now(), id).run();
  return job(await ownedRow(user, id));
}

/** Starts an uploaded job, or continues one that failed or lost its worker.
 * The uploaded pages decide the mode: originals only, answers only, or both paired. */
export async function startStudioJob(user: AuthUser, id: string) {
  const row = await ownedRow(user, id);
  if (row.status !== "uploading" && row.status !== "failed" && !job(row).stalled) throw badRequest("任务正在进行或已完成");
  const draft = await readDraft(id), inputMode = studioInputMode(draft.pages.map(page => page.role));
  if (!inputMode) throw badRequest("请先上传页面");
  if (draft.inputMode !== inputMode) await writeDraft(id, { ...draft, inputMode });
  await db().prepare("UPDATE studio_jobs SET status = 'queued', run_id = '', error = '', progress = '排队中…', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
  await dispatch(id);
  return job(await ownedRow(user, id));
}
export async function cancelStudioJob(user: AuthUser, id: string) {
  await ownedRow(user, id);
  // Reuse the resumable interrupted state; cancellation keeps originals and checkpoints.
  // Revoking the run also makes queued deliveries and late worker updates harmless.
  await db().prepare("UPDATE studio_jobs SET status = 'failed', run_id = '', error = '', progress = '已取消', updated_at = ? WHERE id = ? AND owner_user_id = ? AND status IN ('queued', 'running')")
    .bind(Date.now(), id, user.id).run();
  return job(await ownedRow(user, id));
}
async function dispatch(id: string) {
  const queue = appEnv().HOMEWORK_GRADING_QUEUE;
  if (queue) await queue.send({ kind: "studio_transcription", jobId: id });
  else void processStudioJob(id);
}

export async function getStudioJobDraft(user: AuthUser, id: string) {
  const row = await ownedRow(user, id);
  if (row.status !== "done") throw badRequest("转录尚未完成");
  return { job: job(row), draft: await readDraft(id) };
}
export async function studioJobPageImage(user: AuthUser, id: string, pageId: string) {
  await ownedRow(user, id);
  const object = PAGE_ID.test(pageId) ? await bucket().get(imageKey(id, pageId, "full")) : null;
  if (!object) throw notFound();
  return new Response(object.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" } });
}
export async function deleteStudioJob(user: AuthUser, id: string) {
  await ownedRow(user, id);
  // A worker still running this job finds its row gone at the next checkpoint and stops.
  await db().prepare("DELETE FROM studio_jobs WHERE id = ?").bind(id).run();
  const store = bucket();
  for (let cursor: string | undefined, more = true; more;) {
    const listed = await store.list({ prefix: `studio/${id}/`, cursor });
    if (listed.objects.length) await store.delete(listed.objects.map(object => object.key));
    more = listed.truncated; cursor = listed.truncated ? listed.cursor : undefined;
  }
}

/** The request the page used to make per page, now made by the job. */
async function recognizeStudioPage(image: string, page: StudioPage, draft: StudioDraft, context: string, concurrent: boolean, signal: AbortSignal): Promise<StudioRecord[]> {
  const extra = draft.inputMode === "answers" && page.role === "answer" ? "\n本次只有答案材料，没有干净原题。按材料原顺序识别全部答案条目；没有题干时stem留空，禁止猜测题目或自行解题。只有结果时照录结果并在warnings中说明缺少步骤。利用上页条目判断跨页续解，continuation只在明确续题时为true。解答图和模糊字必须标记待人工确认。" : "";
  const parallelContext = concurrent ? "\n并发识别补充规则：所附上下文来自本批之前已确认页面，不保证是紧邻前一页。优先使用本页可见讲次、栏目与题号；页首明显是续解但归属不明时，仍逐字保留，continuation=true，并在warnings写明‘并发续页归属待确认’，不得套用不相关的旧题号。缺少栏目或讲次且无法从本页确定时也写入warnings，供随后顺序复核。" : "";
  let result;
  try {
    result = await callRecognitionModel({ image, prompt: studioRecognitionPrompt(page.role, draft.title, context) + extra + parallelContext, schema: studioRecognitionSchema, schemaName: "teacher_answer_transcription", signal });
  } catch (error) {
    signal.throwIfAborted();
    const network = error instanceof TypeError && /fetch|network|socket|ECONN|timeout/i.test(error.message);
    throw new StudioRequestError(error instanceof Error ? error.message : "识别失败", network ? 502 : 500, 0, network);
  }
  if (result.status >= 400 || !result.text) throw studioUpstreamError(result, "识别服务未返回结果，请重试当前页");
  return normalizeStudioRecords(parseRecognitionModelText(result.text), page.id, draft.title);
}

class StudioRunYield extends Error {}

export async function processStudioJob(id: string) {
  const runId = crypto.randomUUID(), started = Date.now();
  // One worker owns a run; a duplicate or late message finds nothing to claim.
  const claimed = await db().prepare("UPDATE studio_jobs SET status = 'running', run_id = ?, updated_at = ? WHERE id = ? AND (status = 'queued' OR (status = 'running' AND updated_at < ?))")
    .bind(runId, started, id, started - STALE_MS).run();
  if (!claimed.meta.changes) return;
  const row = await db().prepare("SELECT * FROM studio_jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!row) return;
  const owned = "id = ? AND run_id = ? AND status = 'running'";
  const controller = new AbortController();
  let lastProgress = "";
  const touch = async (fields: { progress?: string; processed?: number; questions?: number }) => {
    if (fields.progress) lastProgress = fields.progress;
    const result = await db().prepare(`UPDATE studio_jobs SET progress = ?, processed_count = COALESCE(?, processed_count), question_count = COALESCE(?, question_count), updated_at = ? WHERE ${owned}`)
      .bind(lastProgress, fields.processed ?? null, fields.questions ?? null, Date.now(), id, runId).run();
    if (!result.meta.changes) {
      controller.abort(new Error("任务已取消、删除或已重新开始"));
      throw controller.signal.reason;
    }
  };
  // Cancellation can arrive in another worker while the provider request is in flight.
  const cancellation = setInterval(() => {
    void db().prepare(`SELECT id FROM studio_jobs WHERE ${owned}`).bind(id, runId).first()
      .then((row: { id: string } | null) => { if (!row) controller.abort(new Error("任务已取消、删除或已重新开始")); })
      .catch(() => undefined);
  }, 1000);
  try {
    const draft = await readDraft(id);
    const result = await transcribeStudio(draft, {
      progress: message => { void touch({ progress: message }).catch(() => undefined); },
      checkpoint: async value => {
        await touch({ processed: value.pages.filter(page => page.processed).length, questions: value.questions.length });
        await writeDraft(id, value);
      },
      recognize: async (page, context, options) => {
        controller.signal.throwIfAborted();
        await touch({});
        if (Date.now() - started > RUN_SLICE_MS) throw new StudioRunYield("本轮运行时间已到");
        const object = await bucket().get(imageKey(id, page.id, "recognize"));
        if (!object) throw new Error(`第 ${page.page} 页原件缺失`);
        controller.signal.throwIfAborted();
        return recognizeStudioPage(bytesDataUrl(await object.arrayBuffer()), page, draft, context, !!options?.concurrent, controller.signal);
      },
      crop: async () => { throw new Error("后台转录不处理配图"); },
      drawings: async () => { throw new Error("后台转录不处理配图"); },
    }, { textConcurrency: row.text_concurrency, drawings: false });
    // The pipeline's last checkpoint already stored this draft.
    await db().prepare(`UPDATE studio_jobs SET status = 'done', progress = '', error = '', processed_count = page_count, question_count = ?, updated_at = ? WHERE ${owned}`)
      .bind(result.questions.length, Date.now(), id, runId).run();
  } catch (error) {
    if (error instanceof StudioRunYield || (error instanceof Error && error.cause instanceof StudioRunYield)) {
      // Saved pages stay processed; the next delivery continues from the checkpoint.
      const requeued = await db().prepare(`UPDATE studio_jobs SET status = 'queued', updated_at = ? WHERE ${owned}`).bind(Date.now(), id, runId).run();
      if (requeued.meta.changes) await dispatch(id);
      return;
    }
    const message = error instanceof Error ? error.message.slice(0, 500) : "转录失败";
    await db().prepare(`UPDATE studio_jobs SET status = 'failed', error = ?, progress = '', updated_at = ? WHERE ${owned}`).bind(message, Date.now(), id, runId).run();
  } finally {
    clearInterval(cancellation);
  }
}
