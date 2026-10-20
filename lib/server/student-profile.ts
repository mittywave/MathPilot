import { env } from "cloudflare:workers";
import { callStructuredAi } from "./ai-gateway";
import { loadPublishedKnowledgeGraph } from "./knowledge-graph";
import { parseRecognitionModelText } from "./recognition-model";
import {
  buildStudentAbilityPrompt, buildStudentReportPrompt, fallbackStudentReportText, normalizeStudentAbilityAnalysis, normalizeStudentReportText,
  reportTimeZone, studentAbilitySchema, studentReportSchema,
} from "../student-profile-contract";
import type { AuthUser, KnowledgeTally, QuestionType, StudentAbilityAnalysis, StudentAbilityEvidence, StudentHomework, StudentProfileSummary, StudentReport, StudentReportData } from "../types";

// 定档 uses published grading evidence for both knowledge tallies and open-ended ability analysis.
type AppEnv = { DB: D1Database };
const QUESTION_TYPES: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];
const DAY = 86_400_000;

function db() {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings.DB;
}
function responseError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}
function parseJson<T>(value: unknown, fallback: T): T {
  try { return value == null ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; }
}

async function ownedStudent(studentId: string, user: AuthUser) {
  const row = await db().prepare("SELECT id, name, class_name FROM students WHERE id = ? AND owner_user_id = ?").bind(studentId, user.id).first<{ id: string; name: string; class_name: string }>();
  if (!row) throw responseError("学生档案不存在", 404);
  return row;
}

/** All evidence is scoped on the server; analysis never accepts client-supplied student work. */
async function readAbilityEvidence(studentId: string, user: AuthUser, since: number | null, until: number | null) {
  const rows = await db().prepare(`WITH eligible AS (
    SELECT g.id, g.submission_id AS submissionId, g.assignment_question_id AS assignmentQuestionId,
      q.question_number AS questionNumber, q.stem, q.options_json, q.answer AS standardAnswer, q.analysis AS standardAnalysis,
      g.student_answer AS studentAnswer, g.verdict, g.feedback, g.step_analysis_json, g.evidence_summary AS evidenceSummary,
      g.bbox_json, a.title, s.version, COALESCE(s.submitted_at, s.created_at) AS submittedAt,
      COUNT(*) OVER () AS total,
      ROW_NUMBER() OVER (PARTITION BY (g.verdict = 'correct') ORDER BY COALESCE(s.submitted_at, s.created_at) DESC, q.sort_order, g.id) AS position
    FROM grading_items g JOIN homework_submissions s ON s.id = g.submission_id
    JOIN homework_assignments a ON a.id = s.assignment_id JOIN assignment_questions q ON q.id = g.assignment_question_id
    WHERE a.owner_user_id = ?1 AND s.student_id = ?2 AND s.status = 'published'
      AND json_extract(a.outputs_json, '$.profile') = 1 AND g.requires_review = 0 AND q.reference_verified = 1
      AND g.verdict IN ('correct', 'partial', 'incorrect')
      AND (?3 IS NULL OR COALESCE(s.submitted_at, s.created_at) >= ?3)
      AND (?4 IS NULL OR COALESCE(s.submitted_at, s.created_at) <= ?4)
  ) SELECT * FROM eligible WHERE position <= CASE WHEN verdict = 'correct' THEN 20 ELSE 60 END
    ORDER BY submittedAt DESC, questionNumber, id`).bind(user.id, studentId, since, until)
    .all<StudentAbilityEvidence & { options_json: string; step_analysis_json: string; bbox_json: string; total: number; position: number }>();
  return {
    abilityEvidenceTotal: Number(rows.results[0]?.total ?? 0),
    abilityEvidence: rows.results.map((row: StudentAbilityEvidence & { options_json: string; step_analysis_json: string; bbox_json: string }) => ({
      id: row.id, submissionId: row.submissionId, assignmentQuestionId: row.assignmentQuestionId,
      questionNumber: row.questionNumber, stem: row.stem, standardAnswer: row.standardAnswer, standardAnalysis: row.standardAnalysis,
      studentAnswer: row.studentAnswer, verdict: row.verdict, feedback: row.feedback, evidenceSummary: row.evidenceSummary,
      title: row.title, version: row.version, submittedAt: row.submittedAt,
      options: parseJson<unknown[]>(row.options_json, []).filter((value): value is string => typeof value === "string"),
      stepAnalysis: parseJson<unknown[]>(row.step_analysis_json, []).filter((value): value is string => typeof value === "string"),
      errorReasons: (parseJson<{ errors?: Array<{ reason?: string }> }>(row.bbox_json, {})?.errors ?? []).map((error) => error.reason).filter((value): value is string => typeof value === "string" && !!value.trim()),
    })),
  };
}

// Short-lived, bounded reuse avoids another model call when switching periods with identical evidence or writing a report.
// The owner/student scope and all source content participate in the key; corrections cannot reuse the old analysis.
const abilityReadings = new Map<string, { at: number; analysis: StudentAbilityAnalysis }>();

/** AI is a separate request so knowledge statistics remain available during analysis or an upstream failure. */
async function analyzeStudentAbilities(evidence: StudentAbilityEvidence[], total: number, scope: string, signal?: AbortSignal, refresh = false): Promise<{ analysis: StudentAbilityAnalysis | null; notice: string }> {
  if (!evidence.length) return { analysis: null, notice: "这段时间还没有可用于能力分析的已确认作答。" };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([scope, total, evidence])));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const cached = abilityReadings.get(key);
  if (!refresh && cached && Date.now() - cached.at < 10 * 60_000) return { analysis: cached.analysis, notice: "" };
  abilityReadings.delete(key);
  try {
    const result = await callStructuredAi({ role: "text", prompt: buildStudentAbilityPrompt(evidence, total), schema: studentAbilitySchema,
      schemaName: "student_ability_analysis", missingMessage: "尚未配置能力分析所用的 AI", signal });
    if (!result.text) return { analysis: null, notice: result.error || "AI 没有返回可用的能力分析" };
    signal?.throwIfAborted();
    const analysis = normalizeStudentAbilityAnalysis(parseRecognitionModelText(result.text), evidence);
    if (abilityReadings.size >= 24) abilityReadings.delete(abilityReadings.keys().next().value!);
    abilityReadings.set(key, { at: Date.now(), analysis });
    return { analysis, notice: "" };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { analysis: null, notice: error instanceof Error ? error.message : "能力分析暂时失败" };
  }
}

export async function readStudentAbilityAnalysis(studentId: string, user: AuthUser, since: number | null, signal?: AbortSignal, refresh = false) {
  await ownedStudent(studentId, user);
  const evidence = await readAbilityEvidence(studentId, user, since, null);
  return { ...evidence, ...await analyzeStudentAbilities(evidence.abilityEvidence, evidence.abilityEvidenceTotal, `${user.id}|${studentId}`, signal, refresh) };
}

/** The selected period's graded knowledge, question types and traceable work. */
export async function readStudentProfile(studentId: string, user: AuthUser, since: number | null, until: number | null = null): Promise<StudentProfileSummary> {
  await ownedStudent(studentId, user);
  const [evidence, types, abilities, graph] = await Promise.all([
    db().prepare(`SELECT capability_key AS key, MAX(capability_label) AS label, verdict, COUNT(*) AS count, MAX(created_at) AS last
      FROM student_capability_evidence WHERE owner_user_id = ? AND student_id = ? AND dimension = 'knowledge' AND (?3 IS NULL OR created_at >= ?3) AND (?4 IS NULL OR created_at <= ?4)
      GROUP BY capability_key, verdict`).bind(user.id, studentId, since, until).all<{ key: string; label: string; verdict: string; count: number; last: number }>(),
    db().prepare(`SELECT q.type, g.verdict, COUNT(*) AS count FROM grading_items g JOIN assignment_questions q ON q.id = g.assignment_question_id
      JOIN homework_submissions s ON s.id = g.submission_id JOIN homework_assignments a ON a.id = s.assignment_id
      WHERE a.owner_user_id = ? AND s.student_id = ? AND s.status = 'published' AND json_extract(a.outputs_json, '$.profile') = 1
        AND g.requires_review = 0 AND g.verdict IN ('correct', 'partial', 'incorrect') AND (?3 IS NULL OR COALESCE(s.submitted_at, s.created_at) >= ?3)
        AND (?4 IS NULL OR COALESCE(s.submitted_at, s.created_at) <= ?4)
      GROUP BY q.type, g.verdict`).bind(user.id, studentId, since, until).all<{ type: QuestionType; verdict: string; count: number }>(),
    readAbilityEvidence(studentId, user, since, until),
    loadPublishedKnowledgeGraph(),
  ]);
  const tallies = new Map<string, KnowledgeTally>();
  for (const row of evidence.results as Array<{ key: string; label: string; verdict: string; count: number; last: number }>) {
    const node = graph.index.node(row.key);
    const tally = tallies.get(row.key) ?? { key: row.key, label: node?.label ?? row.label, level: node?.level === "domain" || node?.level === "topic" ? node.level : "point",
      parentKey: node?.parentKey && node.parentKey !== row.key ? node.parentKey : null, correct: 0, partial: 0, incorrect: 0, lastAt: 0 };
    if (row.verdict === "correct" || row.verdict === "partial" || row.verdict === "incorrect") tally[row.verdict] += Number(row.count);
    tally.lastAt = Math.max(tally.lastAt, Number(row.last));
    tallies.set(row.key, tally);
  }
  const byType = new Map<QuestionType, StudentProfileSummary["types"][number]>();
  for (const row of types.results as Array<{ type: QuestionType; verdict: "correct" | "partial" | "incorrect"; count: number }>) {
    if (!QUESTION_TYPES.includes(row.type)) continue;
    const tally = byType.get(row.type) ?? { type: row.type, correct: 0, partial: 0, incorrect: 0 };
    tally[row.verdict] += Number(row.count); byType.set(row.type, tally);
  }
  return {
    since, knowledge: [...tallies.values()], types: QUESTION_TYPES.flatMap((type) => byType.get(type) ?? []),
    ...abilities,
  };
}

// ---- 学情报告 ----

type ReportRow = { id: string; student_id: string; period_start: number; period_end: number; data_json: string; text_json: string; created_at: number; updated_at: number };
function toReport(row: ReportRow): StudentReport {
  return {
    id: row.id, studentId: row.student_id, periodStart: Number(row.period_start), periodEnd: Number(row.period_end),
    data: parseJson<StudentReportData>(row.data_json, { studentName: "", className: "", homework: [], knowledge: [], types: [], abilityEvidence: [], abilityEvidenceTotal: 0, abilityAnalysis: null, wrongAdded: 0 }),
    text: normalizeStudentReportText(parseJson(row.text_json, {})), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export async function listStudentReports(studentId: string, user: AuthUser) {
  await ownedStudent(studentId, user);
  const rows = await db().prepare("SELECT * FROM student_reports WHERE owner_user_id = ? AND student_id = ? ORDER BY period_end DESC, created_at DESC LIMIT 100")
    .bind(user.id, studentId).all<ReportRow>();
  return (rows.results as ReportRow[]).map(toReport);
}

// A period runs from the start of its first day to the end of its last, at most a year, ending no later than today.
function reportPeriod(raw: { periodStart?: unknown; periodEnd?: unknown }) {
  const start = Number(raw.periodStart), end = Number(raw.periodEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw responseError("请选择报告的起止日期", 400);
  if (end - start > 370 * DAY) throw responseError("一份学情报告最长一年", 400);
  return { start: Math.round(start), end: Math.round(Math.min(end, Date.now() + DAY)) };
}

/**
 * Makes a 学情报告: the archive over the period is copied into the report (homework given or handed in, knowledge and
 * question types graded, ability evidence and analysis, new wrong-book entries), and the model writes the text from that copy alone.
 * Without a model the report still holds the facts in plain sentences, with `notice` saying why.
 */
export async function createStudentReport(studentId: string, user: AuthUser, raw: unknown) {
  const student = await ownedStudent(studentId, user);
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const { start, end } = reportPeriod(body);
  const { readStudentHomework } = await import("./homework");
  const [profile, homework, wrong]: [StudentProfileSummary, StudentHomework[], { count: number } | null] = await Promise.all([
    readStudentProfile(studentId, user, start, end),
    readStudentHomework(studentId, user),
    db().prepare("SELECT COUNT(*) AS count FROM student_wrong_questions WHERE owner_user_id = ? AND student_id = ? AND archived_at IS NULL AND last_wrong_at BETWEEN ? AND ?")
      .bind(user.id, studentId, start, end).first<{ count: number }>(),
  ]);
  const inPeriod = (time: number) => time >= start && time <= end;
  const ability = await analyzeStudentAbilities(profile.abilityEvidence, profile.abilityEvidenceTotal, `${user.id}|${studentId}`);
  const data: StudentReportData = {
    studentName: student.name, className: student.class_name ?? "",
    homework: homework.filter((item) => inPeriod(item.createdAt) || inPeriod(item.latest.updatedAt))
      .map(({ title, assigned, createdAt, total, done, correct, incorrect, pending }) => ({ title, assigned, createdAt, total, done, correct, incorrect, pending })),
    knowledge: profile.knowledge, types: profile.types,
    abilityEvidence: profile.abilityEvidence, abilityEvidenceTotal: profile.abilityEvidenceTotal, abilityAnalysis: ability.analysis,
    wrongAdded: Number(wrong?.count ?? 0),
  };
  let text = fallbackStudentReportText(data), notice = "";
  try {
    const result = await callStructuredAi({ role: "text", prompt: buildStudentReportPrompt({ data, periodStart: start, periodEnd: end, timeZone: reportTimeZone(body.timeZone) }), schema: studentReportSchema, schemaName: "student_report", missingMessage: "尚未配置写学情报告所用的 AI" });
    if (result.text) text = normalizeStudentReportText(parseRecognitionModelText(result.text));
    else notice = result.error || "AI 没有返回可用结果";
  } catch (error) { notice = error instanceof Error ? error.message : "AI 写报告失败"; }
  const id = crypto.randomUUID(); const now = Date.now();
  await db().prepare(`INSERT INTO student_reports (id, owner_user_id, student_id, period_start, period_end, data_json, text_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, user.id, studentId, start, end, JSON.stringify(data), JSON.stringify(text), now, now).run();
  const row = await db().prepare("SELECT * FROM student_reports WHERE id = ?").bind(id).first<ReportRow>();
  return { report: toReport(row!), notice: [notice ? `AI 没写成，报告里先放了数据摘要：${notice}` : "", profile.abilityEvidence.length && ability.notice ? `能力分析未完成：${ability.notice}` : ""].filter(Boolean).join("；") };
}

/** The teacher's edits of the report's text; the data it was written from stays as it was. */
export async function updateStudentReport(studentId: string, id: string, user: AuthUser, raw: unknown) {
  await ownedStudent(studentId, user);
  const body = raw && typeof raw === "object" ? raw as { text?: unknown } : {};
  const result = await db().prepare("UPDATE student_reports SET text_json = ?, updated_at = ? WHERE id = ? AND student_id = ? AND owner_user_id = ?")
    .bind(JSON.stringify(normalizeStudentReportText(body.text)), Date.now(), id, studentId, user.id).run();
  if (!result.meta.changes) throw responseError("这份学情报告不存在", 404);
  const row = await db().prepare("SELECT * FROM student_reports WHERE id = ?").bind(id).first<ReportRow>();
  return toReport(row!);
}

export async function deleteStudentReport(studentId: string, id: string, user: AuthUser) {
  await ownedStudent(studentId, user);
  const result = await db().prepare("DELETE FROM student_reports WHERE id = ? AND student_id = ? AND owner_user_id = ?").bind(id, studentId, user.id).run();
  if (!result.meta.changes) throw responseError("这份学情报告不存在", 404);
}
