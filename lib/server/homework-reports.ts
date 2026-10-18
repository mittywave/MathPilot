import { homeworkDb } from "./homework";
import { buildInternationalReportPrompt, buildSubmissionReportPrompt, internationalReportSchema, normalizeHomeworkReport, submissionReportSchema } from "../homework-grading-contract";
import { buildFallbackInternationalReport, buildFallbackSubmissionReport, completeInternationalReport, normalizeInternationalReport, normalizeSubmissionReport } from "../homework-report.mjs";
import type { AuthUser, HomeworkSubmission, SubmissionReport } from "../types";
import { callHomeworkModel, parseHomeworkModelText } from "./homework-model";

function parseJson<T>(value: unknown, fallback: T): T { try { return value == null ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; } }

export async function readSubmissionReport(submissionId: string): Promise<SubmissionReport | null> {
  const row = await homeworkDb().prepare("SELECT * FROM submission_reports WHERE submission_id = ?").bind(submissionId).first<Record<string, unknown>>();
  if (!row) return null;
  return normalizeSubmissionReport({ overallSummary: row.overall_summary, studentMessage: row.student_message,
    strengths: parseJson(row.strengths_json, []), gaps: parseJson(row.gaps_json, []), actions: parseJson(row.actions_json, []),
    warnings: parseJson(row.warnings_json, []), details: parseJson<Record<string, unknown> | null>(row.details_json, null), generatedAt: Number(row.generated_at), updatedAt: Number(row.updated_at) }, Number(row.updated_at));
}

export async function saveSubmissionReport(submissionId: string, ownerUserId: string, report: SubmissionReport, frameworkVersion: string) {
  const normalized = normalizeSubmissionReport(report); const now = Date.now();
  await homeworkDb().prepare(`INSERT INTO submission_reports
    (submission_id, owner_user_id, framework_version, overall_summary, student_message, strengths_json, gaps_json, actions_json, warnings_json, details_json, generated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submission_id) DO UPDATE SET framework_version = excluded.framework_version, overall_summary = excluded.overall_summary,
      student_message = excluded.student_message, strengths_json = excluded.strengths_json, gaps_json = excluded.gaps_json,
      actions_json = excluded.actions_json, warnings_json = excluded.warnings_json, details_json = excluded.details_json, generated_at = excluded.generated_at, updated_at = excluded.updated_at`)
    .bind(submissionId, ownerUserId, frameworkVersion, normalized.overallSummary, normalized.studentMessage, JSON.stringify(normalized.strengths),
      JSON.stringify(normalized.gaps), JSON.stringify(normalized.actions), JSON.stringify(normalized.warnings), JSON.stringify(normalized.details ?? {}), normalized.generatedAt || now, now).run();
}

/**
 * IGCSE / A Level 批改报告: every sub-part with a score is evidence, including an unreadable answer counted as 0;
 * a pending sub-part stays out and the report lists it as pending.
 */
async function generateInternationalReport(submission: HomeworkSubmission, user: AuthUser) {
  const scored = submission.gradingItems.filter((item) => item.score != null);
  let details = buildFallbackInternationalReport(scored); const warnings: string[] = [];
  if (scored.length) try {
    const result = await callHomeworkModel({ images: [], prompt: buildInternationalReportPrompt(scored), schema: internationalReportSchema, schemaName: "international_homework_report" });
    if (result.text) details = completeInternationalReport(normalizeInternationalReport(parseHomeworkModelText(result.text)), scored);
    else warnings.push("AI 报告暂不可用，失分分析由逐题批改自动汇总。");
  } catch { warnings.push("AI 报告暂不可用，失分分析由逐题批改自动汇总。"); }
  const pending = submission.gradingItems.length - scored.length;
  if (pending) warnings.push(`${pending} 个小问待补图或核实，暂未计分。`);
  await saveSubmissionReport(submission.id, user.id, { details, overallSummary: details.overview, studentMessage: details.checklist, strengths: [], gaps: [], actions: [],
    warnings, generatedAt: Date.now(), updatedAt: Date.now() }, "homework-international-v1");
}

/** 错题报告: a summary of one graded homework, built only from results that have been confirmed. */
export async function generateSubmissionReport(submission: HomeworkSubmission, user: AuthUser) {
  if (submission.curriculum === "international") return generateInternationalReport(submission, user);
  const reliableItems=submission.gradingItems.filter(item=>!item.requiresReview && item.referenceVerified!==false && ["correct","partial","incorrect"].includes(item.verdict));
  const fallback = buildFallbackSubmissionReport(reliableItems);
  let report = reliableItems.length ? fallback : { ...fallback, overallSummary:"本次暂无可确认的批改结果", studentMessage:"请补充清晰完整的作业或参考答案，核实后再继续批改。", strengths:[], gaps:[], actions:["查看待处理题并补图或核实参考解答。"] };
  if(reliableItems.length) try {
    const result = await callHomeworkModel({ images: [], prompt: buildSubmissionReportPrompt(reliableItems),
      schema: submissionReportSchema, schemaName: "homework_submission_report" });
    if (result.text) report = normalizeHomeworkReport(parseHomeworkModelText(result.text));
  } catch { /* Deterministic fallback keeps the automatic pipeline available. */ }
  const pending=submission.gradingItems.length-reliableItems.length;
  if(pending) report={...report,warnings:[...report.warnings,`${pending} 道题待补图或核实，不计入学习表现结论。`]};
  await saveSubmissionReport(submission.id, user.id, report, "homework-grading-v1");
}
