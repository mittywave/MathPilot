import { AiQueueFailure, queueRetryDelay } from "./ai/queue-policy";
import { env } from "cloudflare:workers";
import type { GradingVerdict, QuestionType } from "../types";
import { processHomeworkAssetCleanup, recordHomeworkAssetCleanupFailure } from "./homework-assets";
import { homeworkDb, readTeacherSubmission, withHomeworkGradingRun } from "./homework";
import { readRecognizedQuestionNumbers } from './homework-page-coverage';

type AppEnv = {
  DB: D1Database;
  GRADING_AUTO_CONFIDENCE?: string;
  HOMEWORK_QUEUE_RETRY_BASE_SECONDS?: string;
  HOMEWORK_QUEUE_MAX_ATTEMPTS?: string;
  HOMEWORK_AUTO_PUBLISH_ENABLED?: string;
};
function appEnv(): AppEnv { return env as unknown as AppEnv; }
function autoPublishEnabled() { return String(appEnv().HOMEWORK_AUTO_PUBLISH_ENABLED ?? process.env.HOMEWORK_AUTO_PUBLISH_ENABLED ?? "false").toLowerCase() === "true"; }
function retryBaseSeconds() { return Math.max(1, Math.min(300, Number(appEnv().HOMEWORK_QUEUE_RETRY_BASE_SECONDS ?? process.env.HOMEWORK_QUEUE_RETRY_BASE_SECONDS) || 30)); }
function maxQueueAttempts() { return Math.max(1, Math.min(20, Number(appEnv().HOMEWORK_QUEUE_MAX_ATTEMPTS ?? process.env.HOMEWORK_QUEUE_MAX_ATTEMPTS) || 4)); }
const GRADING_LEASE_MS = 5 * 60_000;

type QuestionRow = {
  id: string; question_number: string; page_number: number; type: QuestionType; stem: string; answer: string; analysis: string; reference_verified: number; input_evidence_json: string;
};
type SubmissionRow = { id: string; assignment_id: string; status: string; reprocess_question_ids_json: string; submitted_at: number | null };

export async function upsertResult(input: {
  submissionId: string; question: QuestionRow; pageId: string | null; verdict: GradingVerdict; score?: number | null; studentAnswer: string;
  feedback: string; errorType: string; stepAnalysis?: string[]; evidenceSummary?: string; capabilityKeys?: string[];
  confidence: number; bbox: unknown; requiresReview: boolean;
}) {
  // A run the teacher stopped (back to 待上传) may still be finishing a batch; it no longer writes results.
  const live = await homeworkDb().prepare(`SELECT a.sheet_json,a.curriculum FROM homework_submissions s
    JOIN homework_assignments a ON a.id=s.assignment_id WHERE s.id=? AND a.status <> 'archived' AND s.status IN ('submitted','processing','failed')`)
    .bind(input.submissionId).first<{sheet_json:string;curriculum:string}>();
  if (!live) return;
  // Assigned school homework has two settled outcomes, including crossed-out or unreadable answers.
  if (live.sheet_json && live.curriculum !== "international") {
    input = { ...input, verdict: input.verdict === "correct" && !input.requiresReview ? "correct" : "incorrect", requiresReview: false,
      score: null, errorType: "", stepAnalysis: [], evidenceSummary: "" };
  }
  if (input.bbox && typeof input.bbox === "object" && (!["incorrect", "partial"].includes(input.verdict) || input.requiresReview)) {
    const bbox = { ...input.bbox } as Record<string, unknown>; delete bbox.errors; input = { ...input, bbox };
  }
  const existing = await homeworkDb().prepare("SELECT id, created_at FROM grading_items WHERE submission_id = ? AND assignment_question_id = ?")
    .bind(input.submissionId, input.question.id).first<{ id: string; created_at: number }>();
  const id = existing?.id ?? crypto.randomUUID(); const now = Date.now();
  if (existing) {
    await homeworkDb().prepare(`UPDATE grading_items SET page_id = ?, verdict = ?, score = ?, student_answer = ?, feedback = ?, error_type = ?,
      step_analysis_json = ?, evidence_summary = ?, capability_keys_json = ?, confidence = ?, bbox_json = ?, requires_review = ?,
      reviewed_by = NULL, reviewed_at = NULL, wrong_book_applied_at = NULL, corrected_at = NULL, updated_at = ? WHERE id = ?`)
      .bind(input.pageId, input.verdict, input.score ?? null, input.studentAnswer, input.feedback, input.errorType, JSON.stringify(input.stepAnalysis ?? []),
        input.evidenceSummary ?? "", JSON.stringify(input.capabilityKeys ?? []), input.confidence,
        input.bbox ? JSON.stringify(input.bbox) : null, input.requiresReview ? 1 : 0, now, id).run();
  } else {
    await homeworkDb().prepare(`INSERT INTO grading_items
      (id, submission_id, assignment_question_id, page_id, verdict, score, student_answer, feedback, error_type, step_analysis_json,
       evidence_summary, capability_keys_json, confidence, bbox_json, requires_review, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.submissionId, input.question.id, input.pageId, input.verdict, input.score ?? null, input.studentAnswer, input.feedback, input.errorType,
        JSON.stringify(input.stepAnalysis ?? []), input.evidenceSummary ?? "", JSON.stringify(input.capabilityKeys ?? []), input.confidence,
        input.bbox ? JSON.stringify(input.bbox) : null, input.requiresReview ? 1 : 0, now, now).run();
  }
}

async function processingSubmission(submissionId: string) {
  return homeworkDb().prepare(`SELECT s.id,s.assignment_id,s.status,s.reprocess_question_ids_json,s.submitted_at FROM homework_submissions s
    JOIN homework_assignments a ON a.id=s.assignment_id WHERE s.id = ? AND a.status <> 'archived'`)
    .bind(submissionId).first<SubmissionRow>();
}

async function finalizeSubmissionIfComplete(submission: SubmissionRow, upperAttempt: number) {
  const scope=await homeworkDb().prepare('SELECT reprocess_question_ids_json FROM homework_submissions WHERE id=?').bind(submission.id).first<{reprocess_question_ids_json:string}>();
  const pendingIds = JSON.parse(scope?.reprocess_question_ids_json || "[]") as string[];
  const recognized=await readRecognizedQuestionNumbers(submission.id);
  const inventory=JSON.stringify(recognized?[...recognized]:[]);
  const counts = await homeworkDb().prepare(`SELECT
      (SELECT COUNT(*) FROM assignment_questions WHERE assignment_id = ? AND question_number IN (SELECT value FROM json_each(?))) AS question_count,
      (SELECT COUNT(*) FROM grading_items g JOIN homework_submissions s ON s.id=g.submission_id JOIN assignment_questions q ON q.id=g.assignment_question_id WHERE g.submission_id = ? AND q.question_number IN (SELECT value FROM json_each(?))
        ${pendingIds.length ? "" : "AND (g.updated_at>=s.submitted_at OR (g.reviewed_at IS NOT NULL AND g.requires_review=0))"}) AS result_count`)
    .bind(submission.assignment_id, inventory, submission.id, inventory).first<{ question_count: number; result_count: number }>();
  if (!counts || !Number(counts.question_count) || Number(counts.result_count) < Number(counts.question_count)) return false;
  await (await import("./homework-page-coverage")).assertCompletePageCoverage(submission.id);
  if (pendingIds.length) {
    const completed = await homeworkDb().prepare(`SELECT COUNT(*) AS count FROM grading_items g JOIN homework_submissions s ON s.id=g.submission_id WHERE g.submission_id=? AND g.assignment_question_id IN (SELECT value FROM json_each(?)) AND (g.updated_at>=s.submitted_at OR (g.reviewed_at IS NOT NULL AND g.requires_review=0))`).bind(submission.id,JSON.stringify(pendingIds)).first<{count:number}>();
    if (Number(completed?.count??0)<pendingIds.length) return false;
  }
  const owner = await homeworkDb().prepare("SELECT owner_user_id FROM homework_assignments WHERE id=? AND status<>'archived'")
    .bind(submission.assignment_id).first<{owner_user_id:string}>();
  if (!owner) return false;
  // Finish explanations while still processing, so analysis failures use the existing queue/retry policy.
  await (await import("./completed-homework-grading")).locateHomeworkErrors(
    await readTeacherSubmission(submission.id, {id:owner.owner_user_id,email:"",role:"member"}), upperAttempt);
  const now = Date.now();
  const claimed = await homeworkDb().prepare(`UPDATE homework_submissions SET status = 'ready', failure_reason = '', updated_at = ?
    WHERE id = ? AND status IN ('submitted', 'processing', 'failed')`).bind(now, submission.id).run();
  if (!claimed.meta.changes && submission.status !== "ready") return true;
  if (autoPublishEnabled()) {
    const { autoPublishSubmission } = await import("./homework");
    await autoPublishSubmission(submission.id);
  }
  return true;
}

async function processHomeworkSubmissionQuestions(submissionId: string, upperAttempt = 1, questionIds?: string[]) {
  const submission = await processingSubmission(submissionId);
  if (submission?.status === "ready") { await finalizeSubmissionIfComplete(submission, upperAttempt); return; }
  if (!submission || !["submitted", "processing", "failed"].includes(submission.status)) return;
  await homeworkDb().prepare("UPDATE homework_submissions SET status = 'processing', failure_reason = '', updated_at = ? WHERE id = ?")
    .bind(Date.now(), submissionId).run();

  const questionsResult = await homeworkDb().prepare(`SELECT id, question_number, page_number, type, stem, answer, analysis, reference_verified, input_evidence_json
    FROM assignment_questions WHERE assignment_id = ? ORDER BY sort_order`)
    .bind(submission.assignment_id).all<QuestionRow>();
  const pendingIds = JSON.parse(submission.reprocess_question_ids_json || "[]") as string[];
  const prior=await homeworkDb().prepare('SELECT g.assignment_question_id,g.updated_at,g.reviewed_at,g.requires_review,s.submitted_at FROM grading_items g JOIN homework_submissions s ON s.id=g.submission_id WHERE g.submission_id=?').bind(submissionId).all<{assignment_question_id:string;updated_at:number;reviewed_at:number|null;requires_review:number;submitted_at:number}>();
  const done=new Set((prior.results as Array<{assignment_question_id:string;updated_at:number;reviewed_at:number|null;requires_review:number;submitted_at:number}>).filter(g=>(g.reviewed_at && !g.requires_review)||g.updated_at>=(g.submitted_at??0)).map(g=>g.assignment_question_id));
  const recognized=await readRecognizedQuestionNumbers(submissionId);
  const questions = questionsResult.results.filter(q => recognized?.has(q.question_number) && (!questionIds || questionIds.includes(q.id)) && (!pendingIds.length || pendingIds.includes(q.id))&&!done.has(q.id));
  await (await import("./completed-homework-grading")).gradeCompletedQuestions(submissionId, questions, upperAttempt, questionIds ? 1 : undefined);
}

export async function processHomeworkSubmission(submissionId: string, upperAttempt = 1, queued = false) {
  const database = homeworkDb();
  const submission = await processingSubmission(submissionId);
  if (!submission || !["submitted", "processing", "ready"].includes(submission.status)) return;
  const runId = crypto.randomUUID(), now = Date.now();
  const claimed = await database.prepare(`UPDATE homework_submissions SET grading_run_id = ?,
    status = CASE WHEN status = 'ready' THEN 'ready' ELSE 'processing' END, failure_reason = '', updated_at = ?
    WHERE id = ? AND submitted_at IS ? AND status IN ('submitted','processing','ready')
      AND (grading_run_id = '' OR updated_at < ?)
      AND EXISTS (SELECT 1 FROM homework_assignments a WHERE a.id = homework_submissions.assignment_id AND a.status <> 'archived')`)
    .bind(runId, now, submissionId, submission.submitted_at, now - GRADING_LEASE_MS).run();
  // A redelivery after a crashed worker must wait for its lease, rather than being acknowledged and lost.
  if (!claimed.meta.changes) return "busy" as const;
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void database.prepare(`UPDATE homework_submissions SET updated_at = ? WHERE id = ? AND grading_run_id = ?
      AND status IN ('processing','ready','published') AND EXISTS
      (SELECT 1 FROM homework_assignments a WHERE a.id = homework_submissions.assignment_id AND a.status <> 'archived')`)
      .bind(Date.now(), submissionId, runId).run().then(result => {
        if (!result.meta.changes) controller.abort(new Error("批改已取消或由另一执行接管"));
      }).catch(() => undefined);
  }, 15_000);
  try {
    await withHomeworkGradingRun(submissionId, runId, controller.signal, async () => {
      if (submission.status !== "ready") {
        await (await import("./completed-homework")).prepareCompletedHomework(submissionId,submission.assignment_id,upperAttempt,ids=>processHomeworkSubmissionQuestions(submissionId,upperAttempt,ids));
        // Batch all pending questions together so sparse pages can fill the same four worker slots.
        await processHomeworkSubmissionQuestions(submissionId, upperAttempt);
      }
      await finalizeSubmissionIfComplete(submission, upperAttempt);
    });
  } catch (error) {
    const owned = await database.prepare("SELECT id FROM homework_submissions WHERE id = ? AND grading_run_id = ? AND status IN ('processing','ready')")
      .bind(submissionId, runId).first();
    if (!owned) return; // An old run cannot fail or retry a newer/cancelled run.
    const delay = queued ? queueRetryDelay(error, upperAttempt, maxQueueAttempts(), retryBaseSeconds()) : null;
    if (delay === null) await recordFinalQueueFailure(submissionId, error, runId);
    else await recordQueueRetry(submissionId, error, upperAttempt, runId);
    throw error;
  } finally {
    clearInterval(heartbeat);
    await database.prepare("UPDATE homework_submissions SET grading_run_id = '' WHERE id = ? AND grading_run_id = ?")
      .bind(submissionId, runId).run();
  }
}

type QueueBody = { kind?: string; submissionId?: string; jobId?: string };
type QueueMessage = { body: QueueBody; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void };
type QueueBatch = { messages: QueueMessage[] };

// Until the queue gives up, the submission stays in progress with a note: a manual retry now would start a second, separately billed run.
async function recordQueueRetry(submissionId: string, error: unknown, attempt: number, runId: string) {
  const cause = error instanceof AiQueueFailure ? "AI 服务中断" : error instanceof Error ? error.message.slice(0, 300).replace(/[。.]$/, "") : "批改中断";
  await homeworkDb().prepare("UPDATE homework_submissions SET status = 'processing', failure_reason = ?, updated_at = ? WHERE id = ? AND grading_run_id = ? AND status IN ('processing','ready')")
    .bind(`${cause}，正在自动重试（第 ${attempt} 次重试，最多 ${maxQueueAttempts() - 1} 次）`, Date.now(), submissionId, runId).run();
}

async function recordFinalQueueFailure(submissionId: string, error: unknown, runId: string) {
  const reason = error instanceof Error ? error.message.slice(0, 500) : "批改失败";
  await homeworkDb().prepare("UPDATE homework_submissions SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ? AND grading_run_id = ? AND status IN ('processing','ready')")
    .bind(reason, Date.now(), submissionId, runId).run();
}

export async function processHomeworkQueue(batch: QueueBatch) {
  for (const message of batch.messages) {
    const { kind, submissionId, jobId } = message.body;
    // 文件转录 and 题库 file imports share this queue; the job records its own failures.
    if (kind === "studio_transcription" && jobId) {
      try { await (await import("./answer-studio-jobs")).processStudioJob(jobId); message.ack(); }
      catch { message.retry({ delaySeconds: 30 }); }
      continue;
    }
    const cleanup = kind === "cleanup_homework_assets" && Boolean(jobId);
    const grading = Boolean(submissionId) && kind === "grade_submission";
    if (!cleanup && !grading) { message.ack(); continue; }
    try {
      if (cleanup) await processHomeworkAssetCleanup(jobId!);
      else if (await processHomeworkSubmission(submissionId!, message.attempts, true) === "busy") {
        message.retry({ delaySeconds: GRADING_LEASE_MS / 1000 });
        continue;
      }
      message.ack();
    } catch (error) {
      const attempts = Math.max(1, Number(message.attempts) || 1);
      const delay = queueRetryDelay(error, attempts, maxQueueAttempts(), retryBaseSeconds());
      if (cleanup) await recordHomeworkAssetCleanupFailure(jobId!, error, delay === null);
      if (delay === null) message.ack();
      else message.retry({ delaySeconds: delay });
    }
  }
}
