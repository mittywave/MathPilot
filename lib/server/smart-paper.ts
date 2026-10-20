import { env } from "cloudflare:workers";
import { callStructuredAi } from "./ai-gateway";
import { loadPublishedKnowledgeGraph } from "./knowledge-graph";
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

// The student digest follows confirmed grading and concrete error causes, without teacher lesson feedback.
async function studentDigest(user: AuthUser, student: { id: string; notes: string }) {
  const [points, { index: graph }] = await Promise.all([
    db().prepare(`SELECT capability_key AS key, MAX(capability_label) AS label, SUM(verdict = 'correct') AS correct, COUNT(*) AS total FROM student_capability_evidence
      WHERE student_id = ? AND owner_user_id = ? AND dimension = 'knowledge' GROUP BY capability_key HAVING COUNT(*) >= 2`).bind(student.id, user.id).all<{ key: string; label: string; correct: number; total: number }>(),
    loadPublishedKnowledgeGraph(),
  ]);
  const lead: string[] = [];
  const weakest = (points.results as Array<{ key: string; label: string; correct: number; total: number }>).filter((row) => graph.node(row.key)?.level === "point")
    .sort((a, b) => a.correct / a.total - b.correct / b.total).slice(0, 8);
  if (weakest.length) lead.push(`批改出来的知识点正确率（从低到高）：${weakest.map((row) => `${row.label} 对 ${row.correct}/${row.total}`).join("；")}`);
  const [types, items, evidence, reports] = await Promise.all([
    db().prepare(`SELECT g.error_type AS type, COUNT(*) AS count FROM grading_items g JOIN homework_submissions s ON s.id = g.submission_id
      JOIN homework_assignments a ON a.id = s.assignment_id
      WHERE s.student_id = ? AND a.owner_user_id = ? AND s.status = 'published' AND g.requires_review = 0
        AND g.verdict IN ('incorrect', 'partial') AND g.error_type <> '' GROUP BY g.error_type ORDER BY count DESC LIMIT 12`).bind(student.id, user.id).all<{ type: string; count: number }>(),
    db().prepare(`SELECT g.feedback, g.step_analysis_json, g.bbox_json, g.student_answer, q.stem, q.question_number, a.title, s.version
      FROM grading_items g JOIN homework_submissions s ON s.id = g.submission_id
      JOIN assignment_questions q ON q.id = g.assignment_question_id JOIN homework_assignments a ON a.id = s.assignment_id
      WHERE s.student_id = ? AND a.owner_user_id = ? AND s.status = 'published' AND g.requires_review = 0
        AND g.verdict IN ('incorrect', 'partial')
      ORDER BY COALESCE(s.submitted_at, s.created_at) DESC, q.sort_order LIMIT 60`).bind(student.id, user.id)
      .all<{ feedback: string; step_analysis_json: string; bbox_json: string; student_answer: string; stem: string; question_number: string; title: string; version: number }>(),
    db().prepare(`SELECT capability_label AS label, COUNT(*) AS count, MAX(diagnosis) AS diagnosis FROM student_capability_evidence
      WHERE student_id = ? AND owner_user_id = ? AND verdict <> 'correct' GROUP BY capability_label ORDER BY count DESC LIMIT 10`).bind(student.id, user.id).all<{ label: string; count: number; diagnosis: string }>(),
    db().prepare(`SELECT r.gaps_json FROM submission_reports r JOIN homework_submissions s ON s.id = r.submission_id
      WHERE s.student_id = ? AND r.owner_user_id = ? AND s.status = 'published' ORDER BY r.updated_at DESC LIMIT 3`).bind(student.id, user.id).all<{ gaps_json: string }>(),
  ]);
  const lines: string[] = [];
  if (student.notes.trim()) lines.push(`老师备注：${text(student.notes, 600)}`);
  lines.push(...lead);
  if (types.results.length) lines.push(`错误类型统计：${types.results.map((row: { type: string; count: number }) => `${row.type} ${row.count} 次`).join("，")}`);
  const gaps = reports.results.flatMap((row: { gaps_json: string }) => jsonList(row.gaps_json).map((gap) => text(record(gap).title, 60))).filter(Boolean);
  if (gaps.length) lines.push(`作业报告里的薄弱点：${[...new Set(gaps)].join("；")}`);
  if (evidence.results.length) lines.push(`能力诊断：${evidence.results.map((row: { label: string; count: number; diagnosis: string }) => `${row.label}（${row.count} 次${row.diagnosis ? `，${text(row.diagnosis, 80)}` : ""}）`).join("；")}`);
  if (items.results.length) lines.push("已发布批改中的历史错因（含局部红圈原文；未作答只说明缺少证据，不据此推断不会）：");
  for (const item of items.results) {
    let errors: unknown[] = [];
    try { const box = record(JSON.parse(item.bbox_json)); if (Array.isArray(box.errors)) errors = box.errors; } catch { /* Older results may have no box. */ }
    const causes = [...new Set([
      ...errors.map((error) => text(record(error).reason, 320)), text(item.feedback, 320),
      ...jsonList(item.step_analysis_json).slice(0, 2).map((step) => text(step, 160)),
    ].filter(Boolean))];
    const source = `《${text(item.title.replace(/\s+/g, " "), 60)}》第${item.question_number}题（第${item.version}次上传）`;
    for (const cause of causes.slice(0, 3)) {
      const unanswered = /^(?:(?:该|此)题)?未作答/.test(cause);
      lines.push(`- ${unanswered ? "未作答记录（待确认）：" : ""}${source}：${cause.replace(/\s*\n\s*/g, " ")}｜学生原答：${text(item.student_answer.replace(/\s+/g, " "), 100)}｜原题：${text(item.stem.replace(/\s+/g, " "), 120)}`);
    }
  }
  let digest = "";
  for (const line of lines) { if (digest.length + line.length > DIGEST_LIMIT) break; digest += `${line}\n`; }
  return digest.trim();
}

// Questions this student has already met: the wrong book, every earlier 智能组卷 plan for them, and every library question
// assigned to them as homework (from any material).
async function metQuestionIds(user: AuthUser, studentId: string) {
  const met = await usedQuestionIds(user, studentId);
  const [wrong, assigned] = await Promise.all([
    db().prepare("SELECT source_question_id FROM student_wrong_questions WHERE student_id = ? AND owner_user_id = ?").bind(studentId, user.id).all<{ source_question_id: string }>(),
    db().prepare(`SELECT DISTINCT json_extract(q.source_json, '$.id') AS id FROM assignment_questions q
      JOIN homework_assignments a ON a.id = q.assignment_id JOIN homework_submissions s ON s.assignment_id = a.id
      WHERE s.student_id = ? AND a.owner_user_id = ? AND q.source_json <> ''`).bind(studentId, user.id).all<{ id: string | null }>(),
  ]);
  for (const row of wrong.results) if (row.source_question_id) met.add(row.source_question_id);
  for (const row of assigned.results) if (row.id) met.add(row.id);
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

  const reading = await callModel(buildSmartPaperBriefPrompt({ request, instruction: current ? instruction : undefined, current: current?.brief, studentName: student?.name, digest, outline }),
    smartPaperBriefSchema, "smart_paper_brief", signal);
  const { brief, findings } = normalizeSmartPaperBriefResult(reading, new Set(outline.map((item) => item.id)), digest);
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

  const selection = await callModel(buildSmartPaperSelectPrompt({ request, brief, findings, digest, candidates, current: previous, instruction }), smartPaperSelectSchema, "smart_paper_select", signal);
  const plan = assembleSmartPaperPlan({ request, studentId: student?.id ?? null, brief, findings, avoided: inScope.length - open.length, selection, candidates });
  return { plan, exclude: [...met].filter((id) => !keep.has(id)) };
}
