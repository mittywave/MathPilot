import { AiQueueFailure, queueRetryDelay } from "./ai/queue-policy";
import { env } from "cloudflare:workers";
import type { GradingVerdict, QuestionType } from "../types";
import { processHomeworkAssetCleanup, recordHomeworkAssetCleanupFailure } from "./homework-assets";
import { homeworkDb } from "./homework";
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

type QuestionRow = {
  id: string; question_number: string; page_number: number; type: QuestionType; stem: string; answer: string; analysis: string; reference_verified: number; input_evidence_json: string;
};
type SubmissionRow = { id: string; assignment_id: string; status: string; reprocess_question_ids_json: string };

export async function upsertResult(input: {
  submissionId: string; question: QuestionRow; pageId: string | null; verdict: GradingVerdict; score?: number | null; studentAnswer: string;
  feedback: string; errorType: string; stepAnalysis?: string[]; evidenceSummary?: string; capabilityKeys?: string[];
  confidence: number; bbox: unknown; requiresReview: boolean;
}) {
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
  return homeworkDb().prepare("SELECT id,assignment_id,status,reprocess_question_ids_json FROM homework_submissions WHERE id = ?")
    .bind(submissionId).first<SubmissionRow>();
}

async function finalizeSubmissionIfComplete(submission: SubmissionRow) {
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
    const completed = await homeworkDb().prepare(`SELECT COUNT(*) AS count FROM grading_items g JOIN homework_submissions s ON s.id=g.submission_id WHERE g.submission_id=? AND g.assignment_question_id IN (${pendingIds.map(()=>"?").join(",")}) AND (g.updated_at>=s.submitted_at OR (g.reviewed_at IS NOT NULL AND g.requires_review=0))`).bind(submission.id,...pendingIds).first<{count:number}>();
    if (Number(completed?.count??0)<pendingIds.length) return false;
  }
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
  if (submission?.status === "ready") { await finalizeSubmissionIfComplete(submission); return; }
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

export async function processHomeworkSubmission(submissionId: string, upperAttempt = 1) {
  const submission = await processingSubmission(submissionId);
  if (submission?.status === "ready") { await finalizeSubmissionIfComplete(submission); return; }
  if (!submission || !["submitted", "processing", "failed"].includes(submission.status)) return;
  // Failures are recorded by the caller: only it knows whether the queue will retry or this was the last attempt.
  await homeworkDb().prepare("UPDATE homework_submissions SET status='processing',failure_reason='',updated_at=? WHERE id=? AND status IN ('submitted','failed')").bind(Date.now(),submissionId).run();
  await (await import("./completed-homework")).prepareCompletedHomework(submissionId,submission.assignment_id,upperAttempt,ids=>processHomeworkSubmissionQuestions(submissionId,upperAttempt,ids));
  // Batch all pending questions together so sparse pages can fill the same four worker slots.
  await processHomeworkSubmissionQuestions(submissionId, upperAttempt);
  await finalizeSubmissionIfComplete(submission);
}

type QueueBody = { kind?: string; submissionId?: string; jobId?: string };
type QueueMessage = { body: QueueBody; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void };
type QueueBatch = { messages: QueueMessage[] };

// Until the queue gives up, the submission stays in progress with a note: a manual retry now would start a second, separately billed run.
async function recordQueueRetry(submissionId: string, error: unknown, attempt: number) {
  const cause = error instanceof AiQueueFailure ? "AI 服务中断" : error instanceof Error ? error.message.slice(0, 300).replace(/[。.]$/, "") : "批改中断";
  await homeworkDb().prepare("UPDATE homework_submissions SET status = 'processing', failure_reason = ?, updated_at = ? WHERE id = ? AND status IN ('submitted', 'processing', 'failed')")
    .bind(`${cause}，正在自动重试（第 ${attempt} 次重试，最多 ${maxQueueAttempts() - 1} 次）`, Date.now(), submissionId).run();
}

async function recordFinalQueueFailure(submissionId: string, error: unknown) {
  const reason = error instanceof Error ? error.message.slice(0, 500) : "批改失败";
  await homeworkDb().prepare("UPDATE homework_submissions SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
    .bind(reason, Date.now(), submissionId).run();
}

export async function processHomeworkQueue(batch: QueueBatch) {
  for (const message of batch.messages) {
    const { kind, submissionId, jobId } = message.body;
    const cleanup = kind === "cleanup_homework_assets" && Boolean(jobId);
    const grading = Boolean(submissionId) && kind === "grade_submission";
    if (!cleanup && !grading) { message.ack(); continue; }
    try {
      if (cleanup) await processHomeworkAssetCleanup(jobId!);
      else await processHomeworkSubmission(submissionId!, message.attempts);
      message.ack();
    } catch (error) {
      const attempts = Math.max(1, Number(message.attempts) || 1);
      const delay = queueRetryDelay(error, attempts, maxQueueAttempts(), retryBaseSeconds());
      if (cleanup) await recordHomeworkAssetCleanupFailure(jobId!, error, delay === null);
      else if (delay === null) await recordFinalQueueFailure(submissionId!, error);
      else await recordQueueRetry(submissionId!, error, attempts);
      if (delay === null) message.ack();
      else message.retry({ delaySeconds: delay });
    }
  }
}
