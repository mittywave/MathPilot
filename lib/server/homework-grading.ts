import { AiQueueFailure, queueRetryDelay } from "./ai/queue-policy";
import { env } from "cloudflare:workers";
import { buildHomeworkGradingPrompt, buildSubmissionReportPrompt, homeworkGradingSchema, normalizeHomeworkGrading, normalizeHomeworkReport, submissionReportSchema } from "../homework-grading-contract";
import { buildFallbackSubmissionReport } from "../homework-report.mjs";
import { finalizeHomeworkVerdict } from "../homework-grading-rules.mjs";
import type { GradingVerdict, QuestionType } from "../types";
import { homeworkAssetDataUrl, processHomeworkAssetCleanup, recordHomeworkAssetCleanupFailure } from "./homework-assets";
import { homeworkDb } from "./homework";
import { callHomeworkModel, parseHomeworkModelText } from "./homework-model";

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
type SubmissionRow = { id: string; assignment_id: string; status: string; input_mode: string; reprocess_question_ids_json: string };

export async function upsertResult(input: {
  submissionId: string; question: QuestionRow; pageId: string | null; verdict: GradingVerdict; studentAnswer: string;
  feedback: string; errorType: string; stepAnalysis?: string[]; evidenceSummary?: string; capabilityKeys?: string[];
  confidence: number; bbox: unknown; requiresReview: boolean;
}) {
  const existing = await homeworkDb().prepare("SELECT id, created_at FROM grading_items WHERE submission_id = ? AND assignment_question_id = ?")
    .bind(input.submissionId, input.question.id).first<{ id: string; created_at: number }>();
  const id = existing?.id ?? crypto.randomUUID(); const now = Date.now();
  if (existing) {
    await homeworkDb().prepare(`UPDATE grading_items SET page_id = ?, verdict = ?, student_answer = ?, feedback = ?, error_type = ?,
      step_analysis_json = ?, evidence_summary = ?, capability_keys_json = ?, confidence = ?, bbox_json = ?, requires_review = ?,
      reviewed_by = NULL, reviewed_at = NULL, wrong_book_applied_at = NULL, corrected_at = NULL, updated_at = ? WHERE id = ?`)
      .bind(input.pageId, input.verdict, input.studentAnswer, input.feedback, input.errorType, JSON.stringify(input.stepAnalysis ?? []),
        input.evidenceSummary ?? "", JSON.stringify(input.capabilityKeys ?? []), input.confidence,
        input.bbox ? JSON.stringify(input.bbox) : null, input.requiresReview ? 1 : 0, now, id).run();
  } else {
    await homeworkDb().prepare(`INSERT INTO grading_items
      (id, submission_id, assignment_question_id, page_id, verdict, student_answer, feedback, error_type, step_analysis_json,
       evidence_summary, capability_keys_json, confidence, bbox_json, requires_review, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.submissionId, input.question.id, input.pageId, input.verdict, input.studentAnswer, input.feedback, input.errorType,
        JSON.stringify(input.stepAnalysis ?? []), input.evidenceSummary ?? "", JSON.stringify(input.capabilityKeys ?? []), input.confidence,
        input.bbox ? JSON.stringify(input.bbox) : null, input.requiresReview ? 1 : 0, now, now).run();
  }
}

async function processingSubmission(submissionId: string) {
  return homeworkDb().prepare("SELECT s.id,s.assignment_id,s.status,s.reprocess_question_ids_json,a.input_mode FROM homework_submissions s JOIN homework_assignments a ON a.id=s.assignment_id WHERE s.id = ?")
    .bind(submissionId).first<SubmissionRow>();
}

export async function generateSubmissionReport(submissionId: string, upperAttempt = 1) {
  const owner = await homeworkDb().prepare(`SELECT homework_assignments.owner_user_id FROM homework_submissions
    JOIN homework_assignments ON homework_assignments.id = homework_submissions.assignment_id WHERE homework_submissions.id = ?`)
    .bind(submissionId).first<{ owner_user_id: string }>();
  if (!owner) throw new Error("提交记录不存在");
  const { readTeacherSubmission } = await import("./homework");
  const submission = await readTeacherSubmission(submissionId, { id: owner.owner_user_id, email: "", role: "member" });
  const reliableItems=submission.gradingItems.filter(item=>!item.requiresReview && item.referenceVerified!==false && ["correct","partial","incorrect"].includes(item.verdict));
  const fallback = buildFallbackSubmissionReport(reliableItems);
  let report = reliableItems.length ? fallback : { ...fallback, overallSummary:"本次暂无可确认的批改结果", studentMessage:"请补充清晰完整的作业或参考答案，核实后再继续批改。", strengths:[], gaps:[], actions:["查看待处理题并补图或核实参考解答。"] };
  if(reliableItems.length) try {
    const result = await callHomeworkModel({ images: [], prompt: buildSubmissionReportPrompt(reliableItems),
      schema: submissionReportSchema, schemaName: "homework_submission_report", upperAttempt });
    if (result.text) report = normalizeHomeworkReport(parseHomeworkModelText(result.text));
  } catch { /* Deterministic fallback keeps the automatic pipeline available. */ }
  const pending=submission.gradingItems.length-reliableItems.length;
  if(pending) report={...report,warnings:[...report.warnings,`${pending} 道题待补图或核实，不计入学习表现结论。`]};
  const { saveSubmissionReport } = await import("./homework-reports");
  await saveSubmissionReport(submissionId, owner.owner_user_id, report, "homework-grading-v1");
  return report;
}

async function finalizeSubmissionIfComplete(submission: SubmissionRow, upperAttempt = 1) {
  const scope=await homeworkDb().prepare('SELECT reprocess_question_ids_json FROM homework_submissions WHERE id=?').bind(submission.id).first<{reprocess_question_ids_json:string}>();
  const pendingIds = JSON.parse(scope?.reprocess_question_ids_json || "[]") as string[];
  const counts = await homeworkDb().prepare(`SELECT
      (SELECT COUNT(*) FROM assignment_questions WHERE assignment_id = ?) AS question_count,
      (SELECT COUNT(*) FROM grading_items g JOIN homework_submissions s ON s.id=g.submission_id WHERE g.submission_id = ?
        ${pendingIds.length ? "" : "AND (g.updated_at>=s.submitted_at OR (g.reviewed_at IS NOT NULL AND g.requires_review=0))"}) AS result_count`)
    .bind(submission.assignment_id, submission.id).first<{ question_count: number; result_count: number }>();
  if (!counts || !Number(counts.question_count) || Number(counts.result_count) < Number(counts.question_count)) return false;
  if(submission.input_mode === "completed_homework") await (await import("./homework-page-coverage")).assertCompletePageCoverage(submission.id);
  if (pendingIds.length) {
    const completed = await homeworkDb().prepare(`SELECT COUNT(*) AS count FROM grading_items g JOIN homework_submissions s ON s.id=g.submission_id WHERE g.submission_id=? AND g.assignment_question_id IN (${pendingIds.map(()=>"?").join(",")}) AND g.updated_at>=s.submitted_at`).bind(submission.id,...pendingIds).first<{count:number}>();
    if (Number(completed?.count??0)<pendingIds.length) return false;
  }
  const now = Date.now();
  const claimed = await homeworkDb().prepare(`UPDATE homework_submissions SET status = 'ready', failure_reason = '', updated_at = ?
    WHERE id = ? AND status IN ('submitted', 'processing', 'failed')`).bind(now, submission.id).run();
  if (!claimed.meta.changes && submission.status !== "ready") return true;
  if (autoPublishEnabled()) {
    await generateSubmissionReport(submission.id, upperAttempt);
    const { autoPublishSubmission } = await import("./homework");
    await autoPublishSubmission(submission.id);
  }
  return true;
}

export async function processHomeworkSubmissionPage(submissionId: string, pageNumberValue: number, upperAttempt = 1) {
  const submission = await processingSubmission(submissionId);
  if (submission?.status === "ready") { await finalizeSubmissionIfComplete(submission,upperAttempt); return; }
  if (!submission || !["submitted", "processing", "failed"].includes(submission.status)) return;
  const pageNumber = Math.max(1, Math.min(200, Math.floor(Number(pageNumberValue) || 1)));
  await homeworkDb().prepare("UPDATE homework_submissions SET status = 'processing', failure_reason = '', updated_at = ? WHERE id = ?")
    .bind(Date.now(), submissionId).run();

  const questionsResult = await homeworkDb().prepare(`SELECT id, question_number, page_number, type, stem, answer, analysis, reference_verified, input_evidence_json
    FROM assignment_questions WHERE assignment_id = ? AND page_number = ? ORDER BY sort_order`)
    .bind(submission.assignment_id, pageNumber).all<QuestionRow>();
  const pendingIds = JSON.parse(submission.reprocess_question_ids_json || "[]") as string[];
  const prior=await homeworkDb().prepare('SELECT g.assignment_question_id,g.updated_at,g.reviewed_at,g.requires_review,s.submitted_at FROM grading_items g JOIN homework_submissions s ON s.id=g.submission_id WHERE g.submission_id=?').bind(submissionId).all<{assignment_question_id:string;updated_at:number;reviewed_at:number|null;requires_review:number;submitted_at:number}>();
  const done=new Set((prior.results as Array<{assignment_question_id:string;updated_at:number;reviewed_at:number|null;requires_review:number;submitted_at:number}>).filter(g=>(g.reviewed_at && !g.requires_review)||g.updated_at>=(g.submitted_at??0)).map(g=>g.assignment_question_id));
  const questions = questionsResult.results.filter(q => (!pendingIds.length || pendingIds.includes(q.id))&&!done.has(q.id));
  if (submission.input_mode === "completed_homework") {
    await (await import("./completed-homework-grading")).gradeCompletedQuestions(submissionId, questions, upperAttempt);
    await finalizeSubmissionIfComplete(submission,upperAttempt); return;
  }
  if (!questions.length) { await finalizeSubmissionIfComplete(submission, upperAttempt); return; }

  for (const question of questions) {
    if (!question.answer.trim() || !question.reference_verified) await upsertResult({ submissionId, question, pageId: null, verdict: "unreadable", studentAnswer: "",
      feedback: "作业模板缺少标准答案，暂时无法可靠批改", errorType: "答案缺失", confidence: 0, bbox: null, requiresReview: true });
  }
  const gradeable = questions.filter((question) => question.answer.trim() && question.reference_verified);
  if (gradeable.length) {
    const [template, studentPage] = await Promise.all([
      homeworkDb().prepare("SELECT asset_id FROM assignment_assets WHERE assignment_id = ? AND role = 'question' AND page_order = ?")
        .bind(submission.assignment_id, pageNumber - 1).first<{ asset_id: string }>(),
      homeworkDb().prepare("SELECT id, processed_asset_id FROM submission_pages WHERE submission_id = ? AND page_order = ?")
        .bind(submissionId, pageNumber - 1).first<{ id: string; processed_asset_id: string }>(),
    ]);
    if (!template || !studentPage) {
      const reason = !template ? "题目模板缺少对应页面" : "学生答卷缺少对应页面";
      const errorType = !template ? "模板缺页" : "漏页";
      for (const question of gradeable) await upsertResult({ submissionId, question, pageId: studentPage?.id ?? null, verdict: "unreadable",
        studentAnswer: "", feedback: reason, errorType, confidence: 0, bbox: null, requiresReview: true });
    } else {
      const images = await Promise.all([homeworkAssetDataUrl(template.asset_id), homeworkAssetDataUrl(studentPage.processed_asset_id)]);
      const result = await callHomeworkModel({ images, prompt: buildHomeworkGradingPrompt(pageNumber, gradeable.map((question) => ({
        questionNumber: question.question_number, type: question.type, stem: question.stem, answer: question.answer, analysis: question.analysis,
      }))), schema: homeworkGradingSchema, schemaName: "homework_page_grading", upperAttempt });
      if (!result.text) throw new AiQueueFailure(result);
      let extracted;
      try { extracted = normalizeHomeworkGrading(parseHomeworkModelText(result.text)); }
      catch { throw new AiQueueFailure({ code: "OUTPUT_INVALID", status: 422, error: "批改结果未通过业务校验，未自动重复请求。" }); }
      for (const question of gradeable) {
        const item = extracted.find((candidate) => candidate.question_number === question.question_number);
        if (!item) {
          await upsertResult({ submissionId, question, pageId: studentPage.id, verdict: "unreadable", studentAnswer: "",
            feedback: "未能在答卷中定位本题作答", errorType: "无法匹配", confidence: 0, bbox: null, requiresReview: true });
          continue;
        }
        const finalized = finalizeHomeworkVerdict({ type: question.type, standardAnswer: question.answer, studentAnswer: item.student_answer,
          answerState: item.verdict === "incorrect" && item.error_type === "漏答" ? "blank" : undefined, modelVerdict: item.verdict, confidence: item.confidence, warnings: item.warnings, threshold: .5 });
        await upsertResult({ submissionId, question, pageId: studentPage.id, verdict: finalized.verdict, studentAnswer: item.student_answer,
          feedback: item.feedback, errorType: item.error_type, stepAnalysis: item.step_analysis, evidenceSummary: item.evidence_summary,
          capabilityKeys: item.capability_keys, confidence: finalized.confidence, bbox: item.bbox, requiresReview: finalized.requiresReview });
      }
    }
  }
  await finalizeSubmissionIfComplete(submission, upperAttempt);
}

export async function processHomeworkSubmission(submissionId: string, upperAttempt = 1) {
  const submission = await processingSubmission(submissionId);
  if (submission?.status === "ready") { await finalizeSubmissionIfComplete(submission,upperAttempt); return; }
  if (!submission || !["submitted", "processing", "failed"].includes(submission.status)) return;
  try {
    await homeworkDb().prepare("UPDATE homework_submissions SET status='processing',failure_reason='',updated_at=? WHERE id=? AND status IN ('submitted','failed')").bind(Date.now(),submissionId).run();
    if (submission.input_mode === "completed_homework") await (await import("./completed-homework")).prepareCompletedHomework(submissionId,submission.assignment_id,upperAttempt);
    const pages = await homeworkDb().prepare("SELECT DISTINCT page_number FROM assignment_questions WHERE assignment_id = ? ORDER BY page_number")
      .bind(submission.assignment_id).all<{ page_number: number }>();
    for (const page of pages.results) await processHomeworkSubmissionPage(submissionId, Number(page.page_number), upperAttempt);
    await finalizeSubmissionIfComplete(submission, upperAttempt);
  } catch (error) {
    await homeworkDb().prepare("UPDATE homework_submissions SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message.slice(0, 500) : "批改失败", Date.now(), submissionId).run();
    throw error;
  }
}

type QueueBody = { kind?: string; submissionId?: string; pageNumber?: number; jobId?: string };
type QueueMessage = { body: QueueBody; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void };
type QueueBatch = { messages: QueueMessage[] };

async function recordFinalQueueFailure(submissionId: string, error: unknown) {
  const reason = error instanceof Error ? error.message.slice(0, 500) : "批改失败";
  await homeworkDb().prepare("UPDATE homework_submissions SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
    .bind(reason, Date.now(), submissionId).run();
}

export async function processHomeworkQueue(batch: QueueBatch) {
  for (const message of batch.messages) {
    const { kind, submissionId, jobId } = message.body;
    const cleanup = kind === "cleanup_homework_assets" && Boolean(jobId);
    const grading = Boolean(submissionId) && ["grade_submission", "grade_submission_page", "recompute_submission_report"].includes(String(kind));
    if (!cleanup && !grading) { message.ack(); continue; }
    try {
      if (cleanup) await processHomeworkAssetCleanup(jobId!);
      else if (kind === "grade_submission_page") await processHomeworkSubmissionPage(submissionId!, Number(message.body.pageNumber), message.attempts);
      else if (kind === "recompute_submission_report") await generateSubmissionReport(submissionId!, message.attempts);
      else await processHomeworkSubmission(submissionId!, message.attempts);
      message.ack();
    } catch (error) {
      const attempts = Math.max(1, Number(message.attempts) || 1);
      const delay = queueRetryDelay(error, attempts, maxQueueAttempts(), retryBaseSeconds());
      if (cleanup) await recordHomeworkAssetCleanupFailure(jobId!, error, delay === null);
      else if (delay === null) await recordFinalQueueFailure(submissionId!, error);
      if (delay === null) message.ack();
      else message.retry({ delaySeconds: delay });
    }
  }
}
