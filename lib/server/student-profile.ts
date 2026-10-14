import { env } from "cloudflare:workers";
import { callStructuredAi } from "./ai-gateway";
import { loadPublishedKnowledgeGraph } from "./knowledge-graph";
import { parseRecognitionModelText } from "./recognition-model";
import { buildObservationPrompt, normalizeAbilityNotes, normalizeObservationResult, observationSchema, OBSERVATION_LIMITS } from "../student-profile-contract";
import type { AbilityNote, AuthUser, KnowledgeTally, QuestionType, StudentObservation, StudentProfileSummary } from "../types";

// 定档: the archive's reading of one student. 客观 is the graded homework the teacher let into the profile (assigned
// homework always is): every knowledge point it touched and every question type, right, partly right or wrong.
// 主观 is the teacher's own words after each lesson, with the abilities a model read from them, quoting the words.
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
  const row = await db().prepare("SELECT id, name FROM students WHERE id = ? AND owner_user_id = ?").bind(studentId, user.id).first<{ id: string; name: string }>();
  if (!row) throw responseError("学生档案不存在", 404);
  return row;
}

type ObservationRow = { id: string; student_id: string; observed_at: number; text: string; abilities_json: string; keywords_json: string; extracted_at: number | null; created_at: number; updated_at: number };
function toObservation(row: ObservationRow): StudentObservation {
  return {
    id: row.id, studentId: row.student_id, observedAt: Number(row.observed_at), text: row.text,
    abilities: normalizeAbilityNotes(parseJson(row.abilities_json, [])), keywords: parseJson<string[]>(row.keywords_json, []),
    extractedAt: row.extracted_at == null ? null : Number(row.extracted_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

/** 客观 and 主观 for one student, from `since` on (null: everything). */
export async function readStudentProfile(studentId: string, user: AuthUser, since: number | null): Promise<StudentProfileSummary> {
  await ownedStudent(studentId, user);
  const [evidence, types, observations, graph] = await Promise.all([
    db().prepare(`SELECT capability_key AS key, MAX(capability_label) AS label, verdict, COUNT(*) AS count, MAX(created_at) AS last
      FROM student_capability_evidence WHERE owner_user_id = ? AND student_id = ? AND dimension = 'knowledge' AND (?3 IS NULL OR created_at >= ?3)
      GROUP BY capability_key, verdict`).bind(user.id, studentId, since).all<{ key: string; label: string; verdict: string; count: number; last: number }>(),
    db().prepare(`SELECT q.type, g.verdict, COUNT(*) AS count FROM grading_items g JOIN assignment_questions q ON q.id = g.assignment_question_id
      JOIN homework_submissions s ON s.id = g.submission_id JOIN homework_assignments a ON a.id = s.assignment_id
      WHERE a.owner_user_id = ? AND s.student_id = ? AND s.status = 'published' AND json_extract(a.outputs_json, '$.profile') = 1
        AND g.requires_review = 0 AND g.verdict IN ('correct', 'partial', 'incorrect') AND (?3 IS NULL OR COALESCE(s.submitted_at, s.created_at) >= ?3)
      GROUP BY q.type, g.verdict`).bind(user.id, studentId, since).all<{ type: QuestionType; verdict: string; count: number }>(),
    db().prepare(`SELECT * FROM student_observations WHERE owner_user_id = ? AND student_id = ? AND (?3 IS NULL OR observed_at >= ?3)
      ORDER BY observed_at DESC, created_at DESC LIMIT 200`).bind(user.id, studentId, since).all<ObservationRow>(),
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
    observations: (observations.results as ObservationRow[]).map(toObservation),
  };
}

async function readObservation(id: string, user: AuthUser) {
  const row = await db().prepare("SELECT * FROM student_observations WHERE id = ? AND owner_user_id = ?").bind(id, user.id).first<ObservationRow>();
  if (!row) throw responseError("这条反馈不存在", 404);
  return row;
}

// The teacher's words are kept whatever the model does; a failed reading leaves extracted_at empty to try again later.
async function extractObservation(id: string, words: string, user: AuthUser) {
  const result = await callStructuredAi({ role: "text", prompt: buildObservationPrompt(words), schema: observationSchema, schemaName: "student_observation", missingMessage: "尚未配置读取课后反馈所用的 AI" });
  if (!result.text) return result.error || "AI 没有返回可用结果";
  let reading;
  try { reading = normalizeObservationResult(parseRecognitionModelText(result.text), words); }
  catch { return "AI 返回的内容不是有效的结构化数据"; }
  await db().prepare("UPDATE student_observations SET abilities_json = ?, keywords_json = ?, extracted_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?")
    .bind(JSON.stringify(reading.abilities), JSON.stringify(reading.keywords), Date.now(), Date.now(), id, user.id).run();
  return "";
}

function observationText(value: unknown) {
  const words = typeof value === "string" ? value.trim().slice(0, OBSERVATION_LIMITS.text) : "";
  if (!words) throw responseError("请写下或说出这节课的情况", 400);
  return words;
}
// A lesson date: a day in the last two years, not in the future.
function observationDay(value: unknown) {
  const time = Number(value);
  if (!Number.isFinite(time)) return Date.now();
  return Math.min(Date.now() + DAY, Math.max(Date.now() - 730 * DAY, Math.round(time)));
}

/** Saves the teacher's words for a lesson and reads the abilities from them; `notice` explains a reading that failed. */
export async function createObservation(studentId: string, user: AuthUser, raw: unknown) {
  await ownedStudent(studentId, user);
  const body = raw && typeof raw === "object" ? raw as { text?: unknown; observedAt?: unknown } : {};
  const words = observationText(body.text); const id = crypto.randomUUID(); const now = Date.now();
  await db().prepare(`INSERT INTO student_observations (id, owner_user_id, student_id, observed_at, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, user.id, studentId, observationDay(body.observedAt), words, now, now).run();
  const notice = await extractObservation(id, words, user).catch((error) => error instanceof Error ? error.message : "读取失败");
  return { observation: toObservation(await readObservation(id, user)), notice };
}

/**
 * Changes one lesson's feedback: new words (read again), a different day, the teacher's own removal of a judgement or
 * keyword, or simply another reading of the same words (extract).
 */
export async function updateObservation(studentId: string, id: string, user: AuthUser, raw: unknown) {
  await ownedStudent(studentId, user);
  const row = await readObservation(id, user);
  if (row.student_id !== studentId) throw responseError("这条反馈不存在", 404);
  const body = raw && typeof raw === "object" ? raw as { text?: unknown; observedAt?: unknown; abilities?: unknown; keywords?: unknown; extract?: unknown } : {};
  const words = body.text === undefined ? row.text : observationText(body.text);
  // New words make the old reading meaningless: it is cleared before the words are read again.
  const reworded = words !== row.text;
  const abilities: AbilityNote[] = reworded ? [] : body.abilities === undefined ? normalizeAbilityNotes(parseJson(row.abilities_json, [])) : normalizeAbilityNotes(body.abilities);
  const keywords = reworded ? [] : body.keywords === undefined ? parseJson<string[]>(row.keywords_json, [])
    : (Array.isArray(body.keywords) ? body.keywords : []).map((item) => String(item ?? "").trim().slice(0, OBSERVATION_LIMITS.keyword)).filter(Boolean).slice(0, OBSERVATION_LIMITS.keywords);
  await db().prepare("UPDATE student_observations SET text = ?, observed_at = ?, abilities_json = ?, keywords_json = ?, extracted_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?")
    .bind(words, body.observedAt === undefined ? row.observed_at : observationDay(body.observedAt), JSON.stringify(abilities), JSON.stringify(keywords), reworded ? null : row.extracted_at, Date.now(), id, user.id).run();
  const notice = body.extract === true || reworded ? await extractObservation(id, words, user).catch((error) => error instanceof Error ? error.message : "读取失败") : "";
  return { observation: toObservation(await readObservation(id, user)), notice };
}

export async function deleteObservation(studentId: string, id: string, user: AuthUser) {
  await ownedStudent(studentId, user);
  const result = await db().prepare("DELETE FROM student_observations WHERE id = ? AND student_id = ? AND owner_user_id = ?").bind(id, studentId, user.id).run();
  if (!result.meta.changes) throw responseError("这条反馈不存在", 404);
}
