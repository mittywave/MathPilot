import { env } from "cloudflare:workers";
import { callStructuredAi } from "./ai-gateway";
import { readLibrary } from "./library";
import { parseRecognitionModelText } from "./recognition-model";
import { usedQuestionIds } from "./typeset-records";
import { categoryDescendants, categoryPath } from "../library-tree";
import {
  assembleSmartPaperPlan, buildSmartPaperBriefPrompt, buildSmartPaperSelectPrompt, normalizeSmartPaperBriefResult, normalizeSmartPaperPlan,
  planQuestionIds, questionComplexity, questionFeatures, smartPaperBriefSchema, smartPaperSelectSchema, SMART_PAPER_LIMITS,
  type SmartPaperCandidate, type SmartPaperOutline,
} from "../smart-paper-contract";
import type { AuthUser, LibraryData } from "../types";

// 智能组卷: the teacher's sentence, read against one student's archive, becomes days of questions from the library.
// The model reads the request once (what range, how many, which focus) and picks once among candidates the server
// chose; every question in the answer must be one of those candidates, and short days are filled locally.
type AppEnv = { DB: D1Database };
const MAX_CANDIDATES = 400;
const DIGEST_LIMIT = 8000;

function db() {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings.DB;
}
function responseError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}
const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown, limit: number) => (typeof value === "string" ? value.trim().slice(0, limit) : "");
const jsonList = (value: unknown) => { try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };

// Modules and categories with their paths, how many questions each holds (with its subcategories) and their usual tags.
function libraryOutline(library: LibraryData): SmartPaperOutline {
  const ids = [...library.modules.map((item) => item.id), ...library.categories.map((item) => item.id)];
  return ids.map((id) => {
    const scope = new Set(categoryDescendants(library.categories, id));
    const questions = library.questions.filter((question) => scope.has(question.categoryId));
    const tags = new Map<string, number>();
    for (const question of questions) for (const tag of question.tags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    return { id, path: categoryPath(library.modules, library.categories, id), count: questions.length, tags: [...tags].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag]) => tag) };
  }).filter((item) => item.count > 0);
}

async function ownStudent(user: AuthUser, id: string) {
  const row = await db().prepare("SELECT id, name, notes FROM students WHERE id = ? AND owner_user_id = ?").bind(id, user.id).first<{ id: string; name: string; notes: string }>();
  if (!row) throw responseError("学生不存在", 404);
  return row;
}

// What the archive says about this student's mistakes, newest first and kept short: error types with counts, the graded
// answers that were wrong or partly wrong (feedback and steps), weak points the capability evidence and reports name,
// and the teacher's own notes.
async function studentDigest(user: AuthUser, student: { id: string; notes: string }) {
  const [types, items, evidence, reports] = await Promise.all([
    db().prepare(`SELECT g.error_type AS type, COUNT(*) AS count FROM grading_items g JOIN homework_submissions s ON s.id = g.submission_id
      WHERE s.student_id = ? AND g.verdict IN ('incorrect', 'partial') AND g.error_type <> '' GROUP BY g.error_type ORDER BY count DESC LIMIT 12`).bind(student.id).all<{ type: string; count: number }>(),
    db().prepare(`SELECT g.error_type, g.feedback, g.step_analysis_json, q.stem FROM grading_items g JOIN homework_submissions s ON s.id = g.submission_id
      JOIN assignment_questions q ON q.id = g.assignment_question_id
      WHERE s.student_id = ? AND g.verdict IN ('incorrect', 'partial') ORDER BY COALESCE(s.submitted_at, s.created_at) DESC LIMIT 60`).bind(student.id)
      .all<{ error_type: string; feedback: string; step_analysis_json: string; stem: string }>(),
    db().prepare(`SELECT capability_label AS label, COUNT(*) AS count, MAX(diagnosis) AS diagnosis FROM student_capability_evidence
      WHERE student_id = ? AND owner_user_id = ? AND verdict <> 'correct' GROUP BY capability_label ORDER BY count DESC LIMIT 10`).bind(student.id, user.id).all<{ label: string; count: number; diagnosis: string }>(),
    db().prepare(`SELECT r.gaps_json FROM submission_reports r JOIN homework_submissions s ON s.id = r.submission_id
      WHERE s.student_id = ? AND r.owner_user_id = ? ORDER BY r.updated_at DESC LIMIT 3`).bind(student.id, user.id).all<{ gaps_json: string }>(),
  ]);
  const lines: string[] = [];
  if (student.notes.trim()) lines.push(`老师备注：${student.notes.trim()}`);
  if (types.results.length) lines.push(`错误类型统计：${types.results.map((row: { type: string; count: number }) => `${row.type} ${row.count} 次`).join("，")}`);
  const gaps = reports.results.flatMap((row: { gaps_json: string }) => jsonList(row.gaps_json).map((gap) => text(record(gap).title, 60))).filter(Boolean);
  if (gaps.length) lines.push(`作业报告里的薄弱点：${[...new Set(gaps)].join("；")}`);
  if (evidence.results.length) lines.push(`能力诊断：${evidence.results.map((row: { label: string; count: number; diagnosis: string }) => `${row.label}（${row.count} 次${row.diagnosis ? `，${text(row.diagnosis, 80)}` : ""}）`).join("；")}`);
  if (items.results.length) lines.push("最近答错或部分答错的题：");
  for (const item of items.results) {
    const steps = jsonList(item.step_analysis_json).slice(0, 2).map((step) => text(step, 100)).filter(Boolean).join("；");
    lines.push(`- [${item.error_type || "未分类"}] ${text(item.feedback, 160)}${steps ? `｜步骤：${steps}` : ""}｜题：${text(item.stem.replace(/\s+/g, " "), 80)}`);
  }
  let digest = "";
  for (const line of lines) { if (digest.length + line.length > DIGEST_LIMIT) break; digest += `${line}\n`; }
  return digest.trim();
}

// Questions this student has already met: the wrong book and every earlier 智能组卷 plan for them.
async function metQuestionIds(user: AuthUser, studentId: string) {
  const met = await usedQuestionIds(user, studentId);
  const wrong = await db().prepare("SELECT source_question_id FROM student_wrong_questions WHERE student_id = ? AND owner_user_id = ?").bind(studentId, user.id).all<{ source_question_id: string }>();
  for (const row of wrong.results) if (row.source_question_id) met.add(row.source_question_id);
  return met;
}

async function callModel(prompt: string, schema: Record<string, unknown>, schemaName: string, signal?: AbortSignal) {
  const result = await callStructuredAi({ role: "text", prompt, schema, schemaName, signal, missingMessage: "尚未配置智能组卷所用的 AI" });
  if (!result.text) throw responseError(result.error || "AI 没有返回可用结果", result.status >= 400 ? result.status : 502);
  try { return parseRecognitionModelText(result.text); }
  catch { throw responseError("AI 返回的内容不是有效的结构化数据，请重试", 502); }
}

export async function generateSmartPaper(user: AuthUser, raw: unknown, signal?: AbortSignal) {
  const body = record(raw);
  const request = text(body.request, SMART_PAPER_LIMITS.request);
  if (!request) throw responseError("请写下要出什么样的练习", 400);
  const instruction = text(body.instruction, 500);
  const current = body.current === undefined || body.current === null ? null : normalizeSmartPaperPlan(body.current);
  const studentId = text(body.studentId, 100);
  const student = studentId ? await ownStudent(user, studentId) : null;
  const library = await readLibrary(user);
  const outline = libraryOutline(library);
  const digest = student ? await studentDigest(user, student) : "";

  const reading = await callModel(buildSmartPaperBriefPrompt({ request, instruction: current ? instruction : undefined, studentName: student?.name, digest, outline }),
    smartPaperBriefSchema, "smart_paper_brief", signal);
  const { brief, findings } = normalizeSmartPaperBriefResult(reading, new Set(outline.map((item) => item.id)));
  if (!brief.categoryIds.length) throw responseError("没能在题库目录里找到对应的内容范围，请在要求里写明是哪部分内容", 422);

  const scope = new Set(brief.categoryIds.flatMap((id) => categoryDescendants(library.categories, id)));
  const keep = new Set(current ? planQuestionIds(current) : []);
  const met = student ? await metQuestionIds(user, student.id) : new Set<string>();
  const stems = new Set<string>();
  const inScope = library.questions.filter((question) => {
    if (!scope.has(question.categoryId) || (brief.questionTypes.length && !brief.questionTypes.includes(question.type))) return false;
    const key = question.stem.replace(/\s+/g, "");
    if (stems.has(key)) return false;
    stems.add(key); return true;
  }).sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""));
  const open = inScope.filter((question) => keep.has(question.id) || !met.has(question.id));
  if (!open.length) throw responseError(inScope.length ? "范围内的题都已经给这位学生用过了" : "这个范围里还没有题", 422);
  // Too many to show the model: the current plan's questions stay, the rest are taken evenly across the range.
  const step = Math.max(1, open.length / MAX_CANDIDATES);
  const sampled = open.length <= MAX_CANDIDATES ? open : open.filter((question, index) => keep.has(question.id) || Math.floor(index / step) !== Math.floor((index - 1) / step));
  const candidates: SmartPaperCandidate[] = sampled.slice(0, MAX_CANDIDATES + keep.size).map((question) => ({
    id: question.id, code: question.code ?? question.id, difficulty: question.difficulty, level: questionComplexity(question.stem), stem: question.stem, features: questionFeatures(question.stem),
  }));
  const byId = new Map(candidates.map((item) => [item.id, item]));
  const previous = current?.groups.map((group) => ({ theme: group.theme, codes: group.items.flatMap((item) => byId.get(item.id)?.code ?? []) }));

  const selection = await callModel(buildSmartPaperSelectPrompt({ brief, candidates, current: previous, instruction }), smartPaperSelectSchema, "smart_paper_select", signal);
  const plan = assembleSmartPaperPlan({ request, studentId: student?.id ?? null, brief, findings, avoided: inScope.length - open.length, selection, candidates });
  return { plan, exclude: [...met].filter((id) => !keep.has(id)) };
}
