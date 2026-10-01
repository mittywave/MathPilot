import { env } from "cloudflare:workers";
import { normalizeSubmissionReport } from "../homework-report.mjs";
import type { SubmissionReport } from "../types";

type AppEnv = { DB: D1Database };
function appEnv(): AppEnv { return env as unknown as AppEnv; }
function parseJson<T>(value: unknown, fallback: T): T { try { return value == null ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; } }

export async function readSubmissionReport(submissionId: string): Promise<SubmissionReport | null> {
  const row = await appEnv().DB.prepare("SELECT * FROM submission_reports WHERE submission_id = ?").bind(submissionId).first<Record<string, unknown>>();
  if (!row) return null;
  return normalizeSubmissionReport({ overallSummary: row.overall_summary, studentMessage: row.student_message,
    strengths: parseJson(row.strengths_json, []), gaps: parseJson(row.gaps_json, []), actions: parseJson(row.actions_json, []),
    warnings: parseJson(row.warnings_json, []), generatedAt: Number(row.generated_at), updatedAt: Number(row.updated_at) }, Number(row.updated_at));
}

export async function saveSubmissionReport(submissionId: string, ownerUserId: string, report: SubmissionReport, frameworkVersion: string) {
  const normalized = normalizeSubmissionReport(report); const now = Date.now();
  await appEnv().DB.prepare(`INSERT INTO submission_reports
    (submission_id, owner_user_id, framework_version, overall_summary, student_message, strengths_json, gaps_json, actions_json, warnings_json, generated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submission_id) DO UPDATE SET framework_version = excluded.framework_version, overall_summary = excluded.overall_summary,
      student_message = excluded.student_message, strengths_json = excluded.strengths_json, gaps_json = excluded.gaps_json,
      actions_json = excluded.actions_json, warnings_json = excluded.warnings_json, generated_at = excluded.generated_at, updated_at = excluded.updated_at`)
    .bind(submissionId, ownerUserId, frameworkVersion, normalized.overallSummary, normalized.studentMessage, JSON.stringify(normalized.strengths),
      JSON.stringify(normalized.gaps), JSON.stringify(normalized.actions), JSON.stringify(normalized.warnings), normalized.generatedAt || now, now).run();
}

