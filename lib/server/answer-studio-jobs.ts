import { env } from "cloudflare:workers";
import type { AuthUser } from "../types";
import { studioInputMode, type StudioDraft, type StudioPage, type StudioRecord } from "../answer-studio";
import { normalizeStudioRecords, studioRecognitionPrompt, studioRecognitionSchema } from "../answer-studio-contract";
import { StudioRequestError, runStudioWindow, studioConcurrency, studioConcurrencyState, studioUpstreamError, type StudioRetryNotice } from "../answer-studio-concurrency";
import { transcribeStudio } from "../answer-studio-pipeline";
import { batchRecognitionSchema, buildBatchRecognitionPrompt, normalizeBatchRecognitionResult, type BatchRecognitionResult, type RecognitionCategory } from "../recognition-contract";
import { callRecognitionModel, parseRecognitionModelText } from "./recognition-model";

/** Background recognition jobs, so the work goes on after the teacher leaves the page. Two kinds share them:
 * 文件转录 (transcription: the browser later downloads the draft to draw figures and build Word) and
 * 题库 file imports (import: the browser later downloads what the AI read on each page and the teacher checks it). */
type StudioQueueMessage = { kind: "studio_transcription"; jobId: string };
type AppEnv = { DB: D1Database; HOMEWORK_ASSETS?: R2Bucket; HOMEWORK_GRADING_QUEUE?: { send(message: StudioQueueMessage): Promise<void> } };
export type StudioJobStatus = "uploading" | "queued" | "running" | "done" | "failed";
export type StudioJobKind = "transcription" | "import";
export type StudioJob = { id: string; kind: StudioJobKind; title: string; status: StudioJobStatus; stalled: boolean; pageCount: number; processedCount: number; questionCount: number; progress: string; error: string; createdAt: number; updatedAt: number };
type JobRow = { id: string; owner_user_id: string; kind: StudioJobKind; title: string; status: StudioJobStatus; run_id: string; text_concurrency: number; page_count: number; processed_count: number; question_count: number; progress: string; error: string; created_at: number; updated_at: number };
// An import job's record: the file, its pages, and what the AI read on each (or why it could not).
// source carries what a Word file gives by question number; notes what its page conversion could not carry.
export type LibraryImportPage = { id: string; page: number; name: string; hash: string; textHint?: string; documentSection?: "questions" | "answers" };
export type LibraryImportSource = Partial<Record<"answers" | "analyses", Record<string, string>> & Record<"analysisXml" | "questionImages" | "options", Record<string, string[]>> & { analysisAssets: Record<string, Record<string, string>> }>;
export type LibraryImportDraft = { version: 1; fileName: string; categories: RecognitionCategory[]; pages: LibraryImportPage[]; results: Record<string, { result?: BatchRecognitionResult; error?: string }>; notes: string[]; source?: LibraryImportSource; updatedAt: number };

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
const importKey = (id: string) => `studio/${id}/import.json`;
const imageKey = (id: string, pageId: string, kind: "full" | "recognize") => `studio/${id}/${pageId}.${kind}.jpg`;
const job = (row: JobRow): StudioJob => ({
  id: row.id, kind: row.kind, title: row.title, status: row.status,
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
async function readImport(id: string) {
  const object = await bucket().get(importKey(id));
  if (!object) throw new Error("导入记录缺失");
  return await object.json<LibraryImportDraft>();
}
async function writeImport(id: string, draft: LibraryImportDraft) {
  await bucket().put(importKey(id), JSON.stringify({ ...draft, updatedAt: Date.now() }), { httpMetadata: { contentType: "application/json" } });
}
const kindOf = (value: unknown): StudioJobKind => value === "import" ? "import" : "transcription";
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

export async function listStudioJobs(user: AuthUser, kind: unknown) {
  const rows = await db().prepare("SELECT * FROM studio_jobs WHERE owner_user_id = ? AND kind = ? AND NOT EXISTS (SELECT 1 FROM exam_papers p WHERE p.job_id=studio_jobs.id) ORDER BY created_at DESC LIMIT 50").bind(user.id, kindOf(kind)).all<JobRow>();
  return rows.results.map(job);
}
/** The nav badges (工具箱 for transcriptions, 题库 for imports): jobs really in progress, queued or running and not stalled. */
export async function countActiveStudioJobs(user: AuthUser, kind: unknown) {
  const row = await db().prepare("SELECT COUNT(*) AS count FROM studio_jobs WHERE owner_user_id = ? AND kind = ? AND status IN ('queued', 'running') AND updated_at >= ?")
    .bind(user.id, kindOf(kind), Date.now() - STALE_MS).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

const stringRecord = (value: unknown, item: (entry: unknown) => boolean) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(item);
function importSource(value: unknown): LibraryImportSource | undefined {
  if (value === undefined || value === null) return undefined;
  const source = value as Record<string, unknown>, text = (entry: unknown) => typeof entry === "string", texts = (entry: unknown) => Array.isArray(entry) && entry.every(text);
  const valid = typeof value === "object" && (["answers", "analyses"] as const).every(key => source[key] === undefined || stringRecord(source[key], text))
    && (["analysisXml", "questionImages", "options"] as const).every(key => source[key] === undefined || stringRecord(source[key], texts))
    && (source.analysisAssets === undefined || stringRecord(source.analysisAssets, entry => stringRecord(entry, text)));
  if (!valid) throw badRequest("Word 原件信息无效");
  return source as LibraryImportSource;
}

export async function createStudioJob(user: AuthUser, input: { title?: unknown; textConcurrency?: unknown; kind?: unknown; categories?: unknown; notes?: unknown; source?: unknown }) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > 200) throw badRequest("请填写资料名称");
  const id = crypto.randomUUID(), now = Date.now(), kind = kindOf(input.kind);
  if (kind === "import") {
    const categories = Array.isArray(input.categories) ? input.categories.slice(0, 300) : [];
    if (!categories.every(item => typeof item?.id === "string" && typeof item?.path === "string")) throw badRequest("分类信息无效");
    const notes = Array.isArray(input.notes) ? input.notes.filter((note): note is string => typeof note === "string").slice(0, 20).map(note => note.slice(0, 300)) : [];
    await writeImport(id, { version: 1, fileName: title, categories: categories.map(item => ({ id: item.id, path: item.path })), pages: [], results: {}, notes, source: importSource(input.source), updatedAt: now });
  } else await writeDraft(id, { version: 1, title, pages: [], questions: [], answers: [], updatedAt: now });
  // An import keeps the two pages at a time the browser used to send; transcription defaults to four.
  await db().prepare("INSERT INTO studio_jobs (id, owner_user_id, kind, title, status, text_concurrency, created_at, updated_at) VALUES (?, ?, ?, ?, 'uploading', ?, ?, ?)")
    .bind(id, user.id, kind, title, studioConcurrency(input.textConcurrency, kind === "import" ? 2 : undefined), now, now).run();
  return job(await ownedRow(user, id));
}

/** Pages arrive one at a time and in source order; the browser waits for each before sending the next. */
export async function addStudioJobPage(user: AuthUser, id: string, input: { page?: unknown; image?: unknown; recognizeImage?: unknown }) {
  const row = await ownedRow(user, id);
  if (row.status !== "uploading") throw badRequest("任务已开始，不能再添加页面");
  if (row.kind === "import") return addImportPage(user, row, input);
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

async function addImportPage(user: AuthUser, row: JobRow, input: { page?: unknown; image?: unknown; recognizeImage?: unknown }) {
  const page = input.page as Partial<LibraryImportPage> | undefined;
  if (!page || typeof page.id !== "string" || !PAGE_ID.test(page.id) || typeof page.name !== "string" || !Number.isInteger(page.page) || typeof page.hash !== "string"
    || (page.textHint !== undefined && typeof page.textHint !== "string") || (page.documentSection !== undefined && page.documentSection !== "questions" && page.documentSection !== "answers")) throw badRequest("页面信息无效");
  const full = dataUrlBytes(input.image), recognize = dataUrlBytes(input.recognizeImage);
  const draft = await readImport(row.id);
  const paper = await (await import("./papers")).paperForJob(row.id);
  if (draft.pages.some(item => paper ? item.id === page.id && item.hash === page.hash : item.hash === page.hash)) return job(row);
  if (paper && draft.pages.some((item: LibraryImportPage) => item.id === page.id)) throw badRequest("页面编号已存在，但内容不同，请重新上传试卷");
  await bucket().put(imageKey(row.id, page.id, "full"), full, { httpMetadata: { contentType: "image/jpeg" } });
  await bucket().put(imageKey(row.id, page.id, "recognize"), recognize, { httpMetadata: { contentType: "image/jpeg" } });
  draft.pages.push({ id: page.id, page: page.page!, name: page.name.slice(0, 200), hash: page.hash, ...(page.textHint ? { textHint: page.textHint.slice(0, 24_000) } : {}), ...(page.documentSection ? { documentSection: page.documentSection } : {}) });
  await writeImport(row.id, draft);
  await db().prepare("UPDATE studio_jobs SET page_count = ?, updated_at = ? WHERE id = ?").bind(draft.pages.length, Date.now(), row.id).run();
  return job(await ownedRow(user, row.id));
}

/** Starts an uploaded job, or continues one that failed or lost its worker. For a transcription the uploaded
 * pages decide the mode: originals only, answers only, or both paired. An import continues with the pages not read yet. */
export async function startStudioJob(user: AuthUser, id: string) {
  const row = await ownedRow(user, id);
  if (row.status !== "uploading" && row.status !== "failed" && !job(row).stalled) throw badRequest("任务正在进行或已完成");
  if (row.kind === "import") {
    const papers = await import("./papers"), paper = await papers.paperForJob(id);
    if (!(await readImport(id)).pages.length && !(paper && (await papers.readPaperDraft(paper.id))?.questions.length)) throw badRequest("请先上传页面");
  }
  else {
    const draft = await readDraft(id), inputMode = studioInputMode(draft.pages.map(page => page.role));
    if (!inputMode) throw badRequest("请先上传页面");
    if (draft.inputMode !== inputMode) await writeDraft(id, { ...draft, inputMode });
  }
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
  if (row.kind === "import") {
    // Pages already read can be checked while the failed ones wait to be continued.
    if (row.status !== "done" && !(row.status === "failed" && row.processed_count > 0)) throw badRequest("识别尚未完成");
    return { job: job(row), draft: await readImport(id) };
  }
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
  if (await (await import("./papers")).paperForJob(id)) throw badRequest("请在试卷中心管理这套试卷");
  // A worker still running this job finds its row gone at the next checkpoint and stops.
  await db().prepare("DELETE FROM studio_jobs WHERE id = ?").bind(id).run();
  const store = bucket();
  for (let cursor: string | undefined, more = true; more;) {
    const listed = await store.list({ prefix: `studio/${id}/`, cursor });
    if (listed.objects.length) await store.delete(listed.objects.map(object => object.key));
    more = listed.truncated; cursor = listed.truncated ? listed.cursor : undefined;
  }
}

/** One page through the recognition model; a failure says whether retrying could help. */
async function recognizePage(input: Parameters<typeof callRecognitionModel>[0] & { signal: AbortSignal }) {
  let result;
  try { result = await callRecognitionModel(input); } catch (error) {
    input.signal.throwIfAborted();
    const network = error instanceof TypeError && /fetch|network|socket|ECONN|timeout/i.test(error.message);
    throw new StudioRequestError(error instanceof Error ? error.message : "识别失败", network ? 502 : 500, 0, network);
  }
  if (result.status >= 400 || !result.text) throw studioUpstreamError(result, "识别服务未返回结果，请重试当前页");
  return result.text;
}

/** The request the page used to make per page, now made by the job. */
async function recognizeStudioPage(image: string, page: StudioPage, draft: StudioDraft, context: string, concurrent: boolean, signal: AbortSignal): Promise<StudioRecord[]> {
  const extra = draft.inputMode === "answers" && page.role === "answer" ? "\n本次只有答案材料，没有干净原题。按材料原顺序识别全部答案条目；没有题干时stem留空，禁止猜测题目或自行解题。只有结果时照录结果并在warnings中说明缺少步骤。利用上页条目判断跨页续解，continuation只在明确续题时为true。解答图和模糊字必须标记待人工确认。" : "";
  const parallelContext = concurrent ? "\n并发识别补充规则：所附上下文来自本批之前已确认页面，不保证是紧邻前一页。优先使用本页可见讲次、栏目与题号；页首明显是续解但归属不明时，仍逐字保留，continuation=true，并在warnings写明‘并发续页归属待确认’，不得套用不相关的旧题号。缺少栏目或讲次且无法从本页确定时也写入warnings，供随后顺序复核。" : "";
  const text = await recognizePage({ image, prompt: studioRecognitionPrompt(page.role, draft.title, context) + extra + parallelContext, schema: studioRecognitionSchema, schemaName: "teacher_answer_transcription", signal });
  return normalizeStudioRecords(parseRecognitionModelText(text), page.id, draft.title);
}

/** The 题库 batch request (the former /api/recognize-batch), one page at a time. */
async function recognizeImportPage(image: string, page: LibraryImportPage, draft: LibraryImportDraft, signal: AbortSignal): Promise<BatchRecognitionResult> {
  const text = await recognizePage({ image, prompt: buildBatchRecognitionPrompt({ categories: draft.categories, fileName: draft.fileName, pageNumber: page.page, textHint: page.textHint }), schema: batchRecognitionSchema, schemaName: "batch_question_extraction", signal });
  try { return normalizeBatchRecognitionResult(parseRecognitionModelText(text), draft.categories); }
  catch { throw new StudioRequestError("识别结果格式不正确，请换用支持 JSON Schema 的模型", 502, 0, true); }
}

class StudioRunYield extends Error {}
type JobRun = { started: number; signal: AbortSignal; touch: (fields: { progress?: string; processed?: number; questions?: number }) => Promise<void> };
const retryProgress = (notice: StudioRetryNotice) => `服务暂时繁忙（${notice.status || "网络"}），${Math.ceil(notice.delayMs / 1000)} 秒后重试 ${notice.attempt}/2；当前并发 ${notice.limit} 路…`;

/** Reads the pages not read yet, a few at a time with the transcription's retries, saving after each window.
 * A page that still fails is kept with its error: the job fails naming those pages, 继续 retries only them,
 * and the pages already read can be opened meanwhile. Returns the number of questions read. */
async function runImport(id: string, row: JobRow, run: JobRun) {
  const draft = await readImport(id), state = studioConcurrencyState(row.text_concurrency, 2);
  const read = () => draft.pages.filter(page => draft.results[page.id]?.result);
  const questions = () => read().reduce((sum, page) => sum + (draft.results[page.id].result?.questions.length ?? 0), 0);
  const pending = draft.pages.filter(page => !draft.results[page.id]?.result);
  for (let offset = 0; offset < pending.length;) {
    if (Date.now() - run.started > RUN_SLICE_MS) throw new StudioRunYield("本轮运行时间已到");
    const batch = pending.slice(offset, offset + state.limit); offset += batch.length;
    await run.touch({ progress: `正在识别第 ${batch.map(page => page.page).join("、")} 页…` });
    const settled = await runStudioWindow(batch, async page => {
      run.signal.throwIfAborted();
      const object = await bucket().get(imageKey(id, page.id, "recognize"));
      if (!object) throw new Error(`第 ${page.page} 页原件缺失`);
      return recognizeImportPage(bytesDataUrl(await object.arrayBuffer()), page, draft, run.signal);
    }, state, notice => { void run.touch({ progress: retryProgress(notice) }).catch(() => undefined); });
    run.signal.throwIfAborted();
    settled.forEach((outcome, index) => {
      const reason = outcome.status === "rejected" ? outcome.reason : null, retried = reason instanceof StudioRequestError && reason.retryable && reason.retryAfterMs <= 60_000;
      draft.results[batch[index].id] = outcome.status === "fulfilled" ? { result: outcome.value } : { error: `${reason instanceof Error ? reason.message.slice(0, 300) : "识别失败"}${retried ? "，自动重试 2 次仍未成功" : ""}` };
    });
    await run.touch({ processed: read().length, questions: questions(), progress: `已识别 ${read().length}/${draft.pages.length} 页` });
    await writeImport(id, draft);
  }
  const failed = draft.pages.filter(page => !draft.results[page.id]?.result);
  if (failed.length) throw new Error(`第 ${failed.map(page => page.page).join("、")} 页识别失败：${draft.results[failed[0].id]?.error ?? "识别失败"}。点“继续”只重试这些页，也可以先打开已识别的部分`);
  return questions();
}

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
    const papers = row.kind === "import" ? await import("./papers") : null;
    const paper = papers ? await papers.paperForJob(id) : null;
    const source = paper ? await readImport(id) : null;
    const questions = paper && papers && source ? await papers.runPaperImport(paper.id,id,runId,source,{
      signal:controller.signal,touch,checkpoint:()=>writeImport(id,source),
      boundary:()=>{if(Date.now()-started>RUN_SLICE_MS)throw new StudioRunYield("本轮运行时间已到");},
      image:async page=>{const object=await bucket().get(imageKey(id,page.id,"full"));if(!object)throw new Error(`第 ${page.page} 页原件缺失`);return object.arrayBuffer();},
      recognize:async(image,prompt,schema)=>{const state=studioConcurrencyState(1);const [result]=await runStudioWindow([image],async value=>recognizePage({image:value,prompt,schema,schemaName:"whole_paper_page",signal:controller.signal}),state,notice=>{void touch({progress:retryProgress(notice)}).catch(()=>undefined);});if(result.status==="rejected")throw result.reason;return result.value;},
    }) : row.kind === "import" ? await runImport(id, row, { started, signal: controller.signal, touch }) : await runTranscription();
    await db().prepare(`UPDATE studio_jobs SET status = 'done', progress = '', error = '', processed_count = page_count, question_count = ?, updated_at = ? WHERE ${owned}`)
      .bind(questions, Date.now(), id, runId).run();
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

  async function runTranscription() {
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
    }, { textConcurrency: row!.text_concurrency, drawings: false });
    // The pipeline's last checkpoint already stored this draft.
    return result.questions.length;
  }
}
