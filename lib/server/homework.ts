import { env } from "cloudflare:workers";
import type {
  Assignment, AssignmentQuestion, AuthUser, GradingItem, GradingVerdict, HomeworkAsset, HomeworkClass,
  HomeworkSubmission, QuestionType, StudentAuth, SubmissionPage, SubmissionStatus,
} from "../types";
import type { ExtractedAssignmentQuestion } from "../homework-grading-contract";
import {
  assignmentAnswerRecoverySchema,
  buildAssignmentAnswerRecoveryPrompt,
  incompleteAssignmentAnswers,
  mergeAssignmentAnswerRecovery,
  normalizeAssignmentAnswerRecovery,
} from "../homework-answer-recovery.mjs";
import { homeworkAssetsBucket, requireHomeworkEnabled, scheduleHomeworkAssetCleanup } from "./homework-assets";

type HomeworkQueueMessage =
  | { kind: "grade_submission"; submissionId: string }
  | { kind: "grade_submission_page"; submissionId: string; pageNumber: number }
  | { kind: "recompute_submission_report"; submissionId: string }
  | { kind: "cleanup_homework_assets"; jobId: string };
type HomeworkQueue = {
  send(message: HomeworkQueueMessage): Promise<void>;
  sendBatch?(messages: Array<{ body: HomeworkQueueMessage }>): Promise<void>;
};
type AppEnv = { DB: D1Database; HOMEWORK_GRADING_QUEUE?: HomeworkQueue };
const ASSIGNMENT_STATUSES = new Set(["draft", "published", "closed", "archived"]);
const SUBMISSION_STATUSES = new Set<SubmissionStatus>(["draft", "submitted", "processing", "review_required", "ready", "published", "returned", "failed"]);
const QUESTION_TYPES: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];
const VERDICTS: GradingVerdict[] = ["correct", "partial", "incorrect", "unreadable", "review_required"];

function appEnv(): AppEnv {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings;
}

function responseError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return value == null ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; }
}
function text(value: unknown, limit: number) { return String(value ?? "").trim().slice(0, limit); }

async function ownedStudent(studentId: string, ownerUserId: string) {
  const row = await appEnv().DB.prepare("SELECT id, name FROM students WHERE id = ? AND owner_user_id = ?")
    .bind(studentId, ownerUserId).first<{ id: string; name: string }>();
  if (!row) throw responseError("学生档案不存在", 404);
  return row;
}

async function ownedAssignment(assignmentId: string, user: AuthUser) {
  const row = await appEnv().DB.prepare("SELECT * FROM homework_assignments WHERE id = ? AND owner_user_id = ?")
    .bind(assignmentId, user.id).first<Record<string, unknown>>();
  if (!row) throw responseError("作业不存在", 404);
  return row;
}

async function assignedToStudent(assignmentId: string, student: StudentAuth) {
  const row = await appEnv().DB.prepare(`SELECT homework_assignments.* FROM homework_assignments
    JOIN assignment_targets ON assignment_targets.assignment_id = homework_assignments.id
    WHERE homework_assignments.id = ? AND homework_assignments.owner_user_id = ? AND assignment_targets.student_id = ?`)
    .bind(assignmentId, student.ownerUserId, student.studentId).first<Record<string, unknown>>();
  if (!row) throw responseError("作业不存在或尚未布置给你", 404);
  return row;
}

async function validateStudentIds(ownerUserId: string, ids: string[]) {
  const unique = [...new Set(ids.map(String))].slice(0, 500);
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(",");
  const result = await appEnv().DB.prepare(`SELECT id FROM students WHERE owner_user_id = ? AND id IN (${placeholders})`)
    .bind(ownerUserId, ...unique).all<{ id: string }>();
  if (result.results.length !== unique.length) throw responseError("部分学生不存在或不属于当前账号", 400);
  return unique;
}

export async function readClasses(user: AuthUser): Promise<HomeworkClass[]> {
  requireHomeworkEnabled();
  const rows = await appEnv().DB.prepare(`SELECT homework_classes.id, homework_classes.name, homework_classes.created_at, homework_classes.updated_at,
      GROUP_CONCAT(homework_class_students.student_id) AS student_ids
    FROM homework_classes LEFT JOIN homework_class_students ON homework_class_students.class_id = homework_classes.id
    WHERE homework_classes.owner_user_id = ? GROUP BY homework_classes.id ORDER BY homework_classes.name COLLATE NOCASE`)
    .bind(user.id).all<Record<string, unknown>>();
  return rows.results.map((row) => ({ id: String(row.id), name: String(row.name),
    studentIds: String(row.student_ids ?? "").split(",").filter(Boolean), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
}

export async function createClass(nameValue: string, studentIds: string[], user: AuthUser) {
  const name = text(nameValue, 80); if (!name) throw responseError("请填写班级名称", 400);
  const students = await validateStudentIds(user.id, studentIds); const now = Date.now(); const id = crypto.randomUUID();
  try {
    await appEnv().DB.prepare("INSERT INTO homework_classes (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, user.id, name, now, now).run();
    for (const studentId of students) await appEnv().DB.prepare("INSERT INTO homework_class_students (class_id, student_id, created_at) VALUES (?, ?, ?)").bind(id, studentId, now).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw responseError("班级名称已存在", 409); throw error;
  }
  return { id, name, studentIds: students, createdAt: now, updatedAt: now } satisfies HomeworkClass;
}

export async function updateClass(id: string, nameValue: string, studentIds: string[], user: AuthUser) {
  const existing = await appEnv().DB.prepare("SELECT created_at FROM homework_classes WHERE id = ? AND owner_user_id = ?").bind(id, user.id).first<{ created_at: number }>();
  if (!existing) throw responseError("班级不存在", 404);
  const name = text(nameValue, 80); if (!name) throw responseError("请填写班级名称", 400);
  const students = await validateStudentIds(user.id, studentIds); const now = Date.now();
  await appEnv().DB.prepare("UPDATE homework_classes SET name = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?").bind(name, now, id, user.id).run();
  await appEnv().DB.prepare("DELETE FROM homework_class_students WHERE class_id = ?").bind(id).run();
  for (const studentId of students) await appEnv().DB.prepare("INSERT INTO homework_class_students (class_id, student_id, created_at) VALUES (?, ?, ?)").bind(id, studentId, now).run();
  return { id, name, studentIds: students, createdAt: Number(existing.created_at), updatedAt: now } satisfies HomeworkClass;
}

export async function deleteClass(id: string, user: AuthUser) {
  const result = await appEnv().DB.prepare("DELETE FROM homework_classes WHERE id = ? AND owner_user_id = ?").bind(id, user.id).run();
  if (!result.meta.changes) throw responseError("班级不存在", 404);
}

function assignmentQuestion(row: Record<string, unknown>): AssignmentQuestion {
  return {
    id: String(row.id), assignmentId: String(row.assignment_id), questionNumber: String(row.question_number), pageNumber: Number(row.page_number),
    type: QUESTION_TYPES.includes(row.type as QuestionType) ? row.type as QuestionType : "解答题", stem: String(row.stem),
    options: parseJson<string[]>(row.options_json, []), answer: String(row.answer ?? ""), analysis: String(row.analysis ?? ""),
    bbox: parseJson(row.bbox_json, null), confidence: Number(row.confidence), warnings: parseJson<string[]>(row.warnings_json, []),
    knowledgeTags: parseJson<string[]>(row.knowledge_tags_json, []), taxonomyKeys: parseJson<string[]>(row.taxonomy_keys_json, []),
    capabilityKeys: parseJson<string[]>(row.capability_keys_json, []),
    referenceSource: row.reference_source as AssignmentQuestion["referenceSource"], referenceVerified: Number(row.reference_verified) === 1, referenceEvidence: String(row.reference_evidence ?? ""),
    sortOrder: Number(row.sort_order), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

async function assignmentDetails(row: Record<string, unknown>, includeAnswers = true): Promise<Assignment> {
  const id = String(row.id);
  const [questions, assets, targets, counts] = await Promise.all([
    appEnv().DB.prepare("SELECT * FROM assignment_questions WHERE assignment_id = ? ORDER BY sort_order").bind(id).all<Record<string, unknown>>(),
    appEnv().DB.prepare(`SELECT homework_assets.id, homework_assets.content_type, homework_assets.byte_size, homework_assets.original_name,
        homework_assets.created_at, assignment_assets.role, assignment_assets.page_order
      FROM assignment_assets JOIN homework_assets ON homework_assets.id = assignment_assets.asset_id
      WHERE assignment_assets.assignment_id = ? ORDER BY assignment_assets.role, assignment_assets.page_order`).bind(id).all<Record<string, unknown>>(),
    appEnv().DB.prepare("SELECT student_id FROM assignment_targets WHERE assignment_id = ? ORDER BY assigned_at").bind(id).all<{ student_id: string }>(),
    appEnv().DB.prepare("SELECT status, COUNT(*) AS count FROM homework_submissions WHERE assignment_id = ? GROUP BY status").bind(id).all<{ status: SubmissionStatus; count: number }>(),
  ]);
  const submissionCounts = Object.fromEntries([...SUBMISSION_STATUSES].map((status) => [status, 0])) as Record<SubmissionStatus, number>;
  for (const count of counts.results) submissionCounts[count.status] = Number(count.count);
  return {
    inputMode: row.input_mode === "completed_homework" ? "completed_homework" : "template",
    id, title: String(row.title), instructions: String(row.instructions ?? ""), status: row.status as Assignment["status"],
    dueAt: row.due_at == null ? null : Number(row.due_at), templateConfirmed: Number(row.template_confirmed) === 1,
    targetStudentIds: targets.results.map((item) => item.student_id),
    questions: questions.results.map(assignmentQuestion).map((question) => includeAnswers ? question : { ...question, answer: "", analysis: "" }),
    assets: assets.results.filter((asset) => includeAnswers || asset.role === "question").map((asset) => ({
      id: String(asset.id), role: asset.role as HomeworkAsset["role"], url: `/api/homework-assets/${asset.id}`,
      contentType: String(asset.content_type), byteSize: Number(asset.byte_size), originalName: String(asset.original_name),
      pageOrder: Number(asset.page_order), createdAt: Number(asset.created_at),
    })),
    submissionCounts, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export async function readAssignments(user: AuthUser) {
  requireHomeworkEnabled();
  const rows = await appEnv().DB.prepare("SELECT * FROM homework_assignments WHERE owner_user_id = ? AND input_mode = 'template' ORDER BY updated_at DESC").bind(user.id).all<Record<string, unknown>>();
  return Promise.all(rows.results.map((row) => assignmentDetails(row)));
}

export async function readAssignment(id: string, user: AuthUser) {
  return assignmentDetails(await ownedAssignment(id, user));
}

export async function createAssignment(raw: Partial<Assignment>, user: AuthUser) {
  requireHomeworkEnabled(); const title = text(raw.title, 120); if (!title) throw responseError("请填写作业名称", 400);
  const targets = await validateStudentIds(user.id, raw.targetStudentIds ?? []); const id = crypto.randomUUID(); const now = Date.now();
  await appEnv().DB.prepare(`INSERT INTO homework_assignments
    (id, owner_user_id, title, instructions, status, due_at, template_confirmed, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', ?, 0, ?, ?)`)
    .bind(id, user.id, title, text(raw.instructions, 2_000), raw.dueAt == null ? null : Number(raw.dueAt), now, now).run();
  for (const studentId of targets) await appEnv().DB.prepare("INSERT INTO assignment_targets (assignment_id, student_id, assigned_at) VALUES (?, ?, ?)").bind(id, studentId, now).run();
  return readAssignment(id, user);
}

async function replaceAssignmentTargets(assignmentId: string, studentIds: string[], user: AuthUser) {
  const targets = await validateStudentIds(user.id, studentIds); const now = Date.now();
  await appEnv().DB.prepare("DELETE FROM assignment_targets WHERE assignment_id = ?").bind(assignmentId).run();
  for (const studentId of targets) await appEnv().DB.prepare("INSERT INTO assignment_targets (assignment_id, student_id, assigned_at) VALUES (?, ?, ?)").bind(assignmentId, studentId, now).run();
}

export async function replaceAssignmentQuestions(assignmentId: string, questions: Partial<AssignmentQuestion>[], user: AuthUser) {
  const assignment = await ownedAssignment(assignmentId, user);
  if (assignment.status !== "draft") throw responseError("已发布作业不能修改题目模板", 409);
  if (questions.length > 200) throw responseError("作业最多包含 200 道题", 400);
  const numbers = new Set<string>(); const now = Date.now();
  const normalized = questions.map((raw, index) => {
    const questionNumber = text(raw.questionNumber, 80) || String(index + 1);
    if (numbers.has(questionNumber)) throw responseError(`题号 ${questionNumber} 重复`, 400); numbers.add(questionNumber);
    return {
      id: raw.id && /^[0-9a-f-]{36}$/i.test(raw.id) ? raw.id : crypto.randomUUID(), questionNumber,
      pageNumber: Math.max(1, Math.min(200, Math.floor(Number(raw.pageNumber) || 1))),
      type: QUESTION_TYPES.includes(raw.type as QuestionType) ? raw.type as QuestionType : "解答题",
      stem: text(raw.stem, 100_000), options: Array.isArray(raw.options) ? raw.options.map((item) => text(item, 2_000)).filter(Boolean).slice(0, 12) : [],
      answer: text(raw.answer, 100_000), analysis: text(raw.analysis, 100_000), bbox: raw.bbox ?? null,
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)), warnings: Array.isArray(raw.warnings) ? raw.warnings.map((item) => text(item, 300)).filter(Boolean).slice(0, 30) : [],
      knowledgeTags: Array.isArray(raw.knowledgeTags) ? [...new Set(raw.knowledgeTags.map((item) => text(item, 80)).filter(Boolean))].slice(0, 8) : [],
      taxonomyKeys: Array.isArray(raw.taxonomyKeys) && raw.taxonomyKeys.length
        ? [...new Set(raw.taxonomyKeys.map((item) => text(item, 120)).filter(Boolean))].slice(0, 8)
        : [],
      capabilityKeys: Array.isArray(raw.capabilityKeys) ? [...new Set(raw.capabilityKeys.map((item) => text(item, 80)).filter(Boolean))].slice(0, 5) : [],
      sortOrder: index,
    };
  });
  if (normalized.some((item) => !item.stem)) throw responseError("每道题都需要题干", 400);
  await appEnv().DB.prepare("DELETE FROM assignment_questions WHERE assignment_id = ?").bind(assignmentId).run();
  for (const item of normalized) await appEnv().DB.prepare(`INSERT INTO assignment_questions
    (id, assignment_id, question_number, page_number, type, stem, options_json, answer, analysis, bbox_json, confidence, warnings_json,
     knowledge_tags_json, taxonomy_keys_json, capability_keys_json, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(item.id, assignmentId, item.questionNumber, item.pageNumber, item.type, item.stem, JSON.stringify(item.options), item.answer, item.analysis,
      item.bbox ? JSON.stringify(item.bbox) : null, item.confidence, JSON.stringify(item.warnings), JSON.stringify(item.knowledgeTags),
      JSON.stringify(item.taxonomyKeys), JSON.stringify(item.capabilityKeys), item.sortOrder, now, now).run();
  await appEnv().DB.prepare("UPDATE homework_assignments SET template_confirmed = 0, updated_at = ? WHERE id = ?").bind(now, assignmentId).run();
}

export async function updateAssignment(id: string, raw: Partial<Assignment> & { action?: string }, user: AuthUser) {
  const existing = await ownedAssignment(id, user); const action = raw.action ?? "update";
  if (action === "publish") {
    if (existing.status !== "draft") throw responseError("只有草稿作业可以发布", 409);
    // 发布按钮直接提交当前草稿时，先落盘前端尚未单独保存的设置、学生和题目。
    // 这样勾选学生后可以直接布置，不会因为数据库仍是空名单而误报未选择学生。
    const title = text(raw.title ?? existing.title, 120); if (!title) throw responseError("请填写作业名称", 400);
    await appEnv().DB.prepare(`UPDATE homework_assignments SET title = ?, instructions = ?, due_at = ?, updated_at = ? WHERE id = ?`)
      .bind(title, text(raw.instructions ?? existing.instructions, 2_000), raw.dueAt === undefined ? existing.due_at : raw.dueAt, Date.now(), id).run();
    if (raw.targetStudentIds !== undefined) await replaceAssignmentTargets(id, raw.targetStudentIds, user);
    if (raw.questions !== undefined) await replaceAssignmentQuestions(id, raw.questions, user);
    const detail = await assignmentDetails(await ownedAssignment(id, user));
    if (!detail.assets.some((asset) => asset.role === "question") || !detail.assets.some((asset) => asset.role === "answer")) throw responseError("请先上传空白题目卷和答案解析", 400);
    if (!detail.questions.length || detail.questions.some((question) => !question.answer)) throw responseError("请先确认每道题的标准答案", 400);
    if (!detail.targetStudentIds.length) throw responseError("请至少选择一名学生", 400);
    await appEnv().DB.prepare("UPDATE homework_assignments SET status = 'published', template_confirmed = 1, updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
    return readAssignment(id, user);
  }
  if (action === "close" || action === "archive") {
    const status = action === "close" ? "closed" : "archived";
    await appEnv().DB.prepare("UPDATE homework_assignments SET status = ?, updated_at = ? WHERE id = ?").bind(status, Date.now(), id).run();
    return readAssignment(id, user);
  }
  if (existing.status !== "draft") throw responseError("已发布作业只能关闭或归档", 409);
  const title = text(raw.title ?? existing.title, 120); if (!title) throw responseError("请填写作业名称", 400);
  await appEnv().DB.prepare(`UPDATE homework_assignments SET title = ?, instructions = ?, due_at = ?, updated_at = ? WHERE id = ?`)
    .bind(title, text(raw.instructions ?? existing.instructions, 2_000), raw.dueAt === undefined ? existing.due_at : raw.dueAt, Date.now(), id).run();
  if (raw.targetStudentIds) await replaceAssignmentTargets(id, raw.targetStudentIds, user);
  if (raw.questions) await replaceAssignmentQuestions(id, raw.questions, user);
  return readAssignment(id, user);
}

async function assignmentAssetIds(assignmentId: string) {
  const rows = await appEnv().DB.prepare(`SELECT DISTINCT homework_assets.id, homework_assets.r2_key FROM homework_assets
    WHERE homework_assets.upload_assignment_id = ? OR homework_assets.upload_submission_id IN (
      SELECT id FROM homework_submissions WHERE assignment_id = ?
    ) OR homework_assets.id IN (
      SELECT asset_id FROM assignment_assets WHERE assignment_id = ?
      UNION SELECT original_asset_id FROM submission_pages JOIN homework_submissions ON homework_submissions.id = submission_pages.submission_id WHERE homework_submissions.assignment_id = ?
      UNION SELECT processed_asset_id FROM submission_pages JOIN homework_submissions ON homework_submissions.id = submission_pages.submission_id WHERE homework_submissions.assignment_id = ?
    )`).bind(assignmentId, assignmentId, assignmentId, assignmentId, assignmentId).all<{ id: string; r2_key: string }>();
  return rows.results;
}

export async function deleteAssignment(id: string, user: AuthUser) {
  await ownedAssignment(id, user); const assets = await assignmentAssetIds(id);
  await appEnv().DB.prepare("DELETE FROM homework_assignments WHERE id = ? AND owner_user_id = ?").bind(id, user.id).run();
  for (const asset of assets) await appEnv().DB.prepare("DELETE FROM homework_assets WHERE id = ?").bind(asset.id).run();
  await scheduleHomeworkAssetCleanup(user.id, assets.map((asset) => asset.r2_key));
}

function submissionPage(row: Record<string, unknown>): SubmissionPage {
  return {
    id: String(row.id), submissionId: String(row.submission_id), pageOrder: Number(row.page_order),
    originalAssetId: String(row.original_asset_id), processedAssetId: String(row.processed_asset_id),
    originalUrl: `/api/homework-assets/${row.original_asset_id}`, processedUrl: `/api/homework-assets/${row.processed_asset_id}`,
    quality: parseJson(row.quality_json, { score: 0, warnings: [] }), createdAt: Number(row.created_at),
  };
}

function gradingItem(row: Record<string, unknown>): GradingItem {
  return {
    id: String(row.id), submissionId: String(row.submission_id), assignmentQuestionId: String(row.assignment_question_id),
    pageId: row.page_id == null ? null : String(row.page_id), questionNumber: String(row.question_number), questionType: row.question_type as QuestionType,
    referenceSource: row.reference_source as GradingItem["referenceSource"], referenceVerified: Number(row.reference_verified) === 1, referenceEvidence: String(row.reference_evidence ?? ""),
    stem: String(row.stem), standardAnswer: String(row.standard_answer), standardAnalysis: String(row.standard_analysis),
    verdict: VERDICTS.includes(row.verdict as GradingVerdict) ? row.verdict as GradingVerdict : "review_required",
    studentAnswer: String(row.student_answer ?? ""), feedback: String(row.feedback ?? ""), errorType: String(row.error_type ?? ""),
    stepAnalysis: parseJson<string[]>(row.step_analysis_json, []), evidenceSummary: String(row.evidence_summary ?? ""),
    capabilityKeys: parseJson<string[]>(row.capability_keys_json, []),
    confidence: Number(row.confidence), bbox: parseJson(row.bbox_json, null), requiresReview: Number(row.requires_review) === 1,
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at), correctedAt: row.corrected_at == null ? null : Number(row.corrected_at),
    wrongBookAppliedAt: row.wrong_book_applied_at == null ? null : Number(row.wrong_book_applied_at),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

async function submissionDetails(row: Record<string, unknown>, includeAnswers = true): Promise<HomeworkSubmission> {
  const id = String(row.id);
  const [pages, grading, report, revisions, documents] = await Promise.all([
    appEnv().DB.prepare("SELECT * FROM submission_pages WHERE submission_id = ? ORDER BY page_order").bind(id).all<Record<string, unknown>>(),
    includeAnswers ? appEnv().DB.prepare(`SELECT grading_items.*, assignment_questions.question_number, assignment_questions.type AS question_type,
        assignment_questions.stem, assignment_questions.answer AS standard_answer, assignment_questions.analysis AS standard_analysis, assignment_questions.reference_source, assignment_questions.reference_verified, assignment_questions.reference_evidence
      FROM grading_items JOIN assignment_questions ON assignment_questions.id = grading_items.assignment_question_id
      WHERE grading_items.submission_id = ? ORDER BY assignment_questions.sort_order`).bind(id).all<Record<string, unknown>>() : Promise.resolve({ results: [] as Record<string, unknown>[] }),
    includeAnswers ? import("./homework-reports").then(({ readSubmissionReport }) => readSubmissionReport(id)) : Promise.resolve(null),
    appEnv().DB.prepare("SELECT * FROM submission_page_revisions WHERE submission_id=? ORDER BY created_at").bind(id).all<Record<string,unknown>>(),
    appEnv().DB.prepare("SELECT id,original_name FROM homework_assets WHERE upload_submission_id=? AND role='submission_original' AND content_type='application/pdf'").bind(id).all<{id:string;original_name:string}>(),
  ]);
  const pageCoverage = row.input_mode === "completed_homework" ? await (await import("./homework-page-coverage")).readPageCoverage(id) : undefined;
  const processingProgress = includeAnswers && row.input_mode === "completed_homework" ? await appEnv().DB.prepare(`SELECT
    (SELECT COUNT(*) FROM assignment_questions WHERE assignment_id=?) AS identified,
    (SELECT COUNT(*) FROM assignment_questions WHERE assignment_id=? AND (reference_fingerprint<>'' OR reference_evidence LIKE '教师补充并确认%' OR json_extract(input_evidence_json,'$.question_complete')=0)) AS referenceChecked,
    (SELECT COUNT(*) FROM grading_items WHERE submission_id=? AND (updated_at>=? OR (reviewed_at IS NOT NULL AND requires_review=0))) AS graded`)
    .bind(row.assignment_id,row.assignment_id,id,row.submitted_at??0).first<{identified:number;referenceChecked:number;graded:number}>() : undefined;
  const failureReason = includeAnswers || row.status === "returned"
    ? String(row.failure_reason ?? "")
    : row.status === "failed" ? "自动批改暂时失败，老师会处理或重新尝试" : "";
  return {
    processingProgress,
    pageCoverage,
    inputMode: row.input_mode === "completed_homework" ? "completed_homework" : "template",
    gradingSummary: includeAnswers ? { correct: grading.results.filter(i => i.verdict === "correct" && !Number(i.requires_review)).length, partial: grading.results.filter(i => i.verdict === "partial" && !Number(i.requires_review)).length, incorrect: grading.results.filter(i => i.verdict === "incorrect" && !Number(i.requires_review)).length, unresolved: grading.results.filter(i => ["unreadable", "review_required"].includes(String(i.verdict)) || Number(i.requires_review)).length, archived: grading.results.filter(i => i.verdict === "incorrect" && !Number(i.requires_review) && Number(i.reference_verified) && i.wrong_book_applied_at != null).length } : undefined,
    id, assignmentId: String(row.assignment_id), assignmentTitle: String(row.assignment_title), studentId: String(row.student_id), studentName: String(row.student_name),
    version: Number(row.version), status: row.status as SubmissionStatus, submittedByType: row.submitted_by_type as "teacher" | "student",
    submittedAt: row.submitted_at == null ? null : Number(row.submitted_at), publishedAt: row.published_at == null ? null : Number(row.published_at),
    returnedAt: row.returned_at == null ? null : Number(row.returned_at), failureReason,
    originalDocuments: documents.results.map(d=>({name:d.original_name,url:`/api/homework-assets/${d.id}`})),
    pageRevisions: revisions.results.map(r=>({pageId:String(r.page_id),originalUrl:`/api/homework-assets/${r.original_asset_id}`,processedUrl:`/api/homework-assets/${r.processed_asset_id}`,createdAt:Number(r.created_at)})),
    pages: pages.results.map(submissionPage), gradingItems: grading.results.map(gradingItem), report,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

const SUBMISSION_SELECT = `SELECT homework_submissions.*, homework_assignments.title AS assignment_title,
  homework_assignments.owner_user_id AS owner_user_id, homework_assignments.input_mode, students.name AS student_name
  FROM homework_submissions JOIN homework_assignments ON homework_assignments.id = homework_submissions.assignment_id
  JOIN students ON students.id = homework_submissions.student_id`;

async function teacherSubmissionRow(id: string, user: AuthUser) {
  const row = await appEnv().DB.prepare(`${SUBMISSION_SELECT} WHERE homework_submissions.id = ? AND homework_assignments.owner_user_id = ?`)
    .bind(id, user.id).first<Record<string, unknown>>();
  if (!row) throw responseError("提交记录不存在", 404); return row;
}

async function studentSubmissionRow(id: string, student: StudentAuth) {
  const row = await appEnv().DB.prepare(`${SUBMISSION_SELECT} WHERE homework_submissions.id = ? AND homework_submissions.student_id = ?`)
    .bind(id, student.studentId).first<Record<string, unknown>>();
  if (!row) throw responseError("提交记录不存在", 404); return row;
}

export async function readTeacherSubmissions(assignmentId: string, user: AuthUser) {
  if (assignmentId) await ownedAssignment(assignmentId, user);
  const rows = await appEnv().DB.prepare(`${SUBMISSION_SELECT} WHERE homework_assignments.owner_user_id = ? ${assignmentId ? "AND homework_submissions.assignment_id = ?" : ""} ORDER BY homework_submissions.updated_at DESC`)
    .bind(...(assignmentId ? [user.id, assignmentId] : [user.id])).all<Record<string, unknown>>();
  return Promise.all(rows.results.map((row) => submissionDetails(row)));
}

export async function readTeacherSubmission(id: string, user: AuthUser) { return submissionDetails(await teacherSubmissionRow(id, user)); }
export async function readStudentSubmission(id: string, student: StudentAuth) {
  const row = await studentSubmissionRow(id, student); const visible = row.status === "published";
  return submissionDetails(row, visible);
}

export async function readStudentAssignments(student: StudentAuth) {
  requireHomeworkEnabled();
  const rows = await appEnv().DB.prepare(`SELECT homework_assignments.* FROM homework_assignments
    JOIN assignment_targets ON assignment_targets.assignment_id = homework_assignments.id
    WHERE assignment_targets.student_id = ? AND homework_assignments.owner_user_id = ? AND homework_assignments.status IN ('published', 'closed') AND homework_assignments.input_mode = 'template'
    ORDER BY homework_assignments.due_at IS NULL, homework_assignments.due_at, homework_assignments.updated_at DESC`)
    .bind(student.studentId, student.ownerUserId).all<Record<string, unknown>>();
  return Promise.all(rows.results.map((row) => assignmentDetails(row, false)));
}

export async function readStudentSubmissions(student: StudentAuth) {
  const rows = await appEnv().DB.prepare(`${SUBMISSION_SELECT} WHERE homework_submissions.student_id = ? AND homework_assignments.owner_user_id = ? ORDER BY homework_submissions.updated_at DESC`)
    .bind(student.studentId,student.ownerUserId).all<Record<string, unknown>>();
  return Promise.all(rows.results.map((row) => submissionDetails(row, row.status === "published")));
}

export async function createCompletedSubmission(input: { studentId: string; title: string }, user: AuthUser) {
  requireHomeworkEnabled(); await ownedStudent(input.studentId, user.id);
  const title = text(input.title,120); if (!title) throw responseError("请填写作业名称",400);
  const assignmentId=crypto.randomUUID(), id=crypto.randomUUID(), now=Date.now();
  await appEnv().DB.batch([
    appEnv().DB.prepare("INSERT INTO homework_assignments(id,owner_user_id,title,instructions,status,template_confirmed,created_at,updated_at,input_mode) VALUES(?,?,?,'','draft',0,?,?,'completed_homework')").bind(assignmentId,user.id,title,now,now),
    appEnv().DB.prepare("INSERT INTO assignment_targets(assignment_id,student_id,assigned_at) VALUES(?,?,?)").bind(assignmentId,input.studentId,now),
    appEnv().DB.prepare("INSERT INTO homework_submissions(id,assignment_id,student_id,version,status,submitted_by_type,submitted_by_id,created_at,updated_at) VALUES(?,?,?,1,'draft','teacher',?,?,?)").bind(id,assignmentId,input.studentId,user.id,now,now),
  ]);
  return readTeacherSubmission(id,user);
}

export async function createSubmission(input: { assignmentId: string; studentId?: string; newVersion?: boolean }, actor: AuthUser | StudentAuth) {
  const teacher = "role" in actor ? actor : null; const studentAuth = "studentId" in actor && !("role" in actor) ? actor : null;
  const studentId = teacher ? String(input.studentId ?? "") : studentAuth!.studentId;
  if (teacher) {
    const assignment = await ownedAssignment(input.assignmentId, teacher); await ownedStudent(studentId, teacher.id);
    if (assignment.status !== "published" && !(assignment.input_mode === "completed_homework" && assignment.status === "closed")) throw responseError("该作业当前不可提交", 409);
    const target = await appEnv().DB.prepare("SELECT 1 FROM assignment_targets WHERE assignment_id = ? AND student_id = ?")
      .bind(input.assignmentId, studentId).first();
    if (!target) throw responseError("该学生不在作业布置范围内", 403);
  }
  else {
    const assignment = await assignedToStudent(input.assignmentId, studentAuth!);
    if (assignment.status !== "published") throw responseError("该作业当前不可提交", 409);
  }
  const latest = await appEnv().DB.prepare(`SELECT id, version, status FROM homework_submissions
    WHERE assignment_id = ? AND student_id = ? ORDER BY version DESC LIMIT 1`).bind(input.assignmentId, studentId)
    .first<{ id: string; version: number; status: SubmissionStatus }>();
  if (latest && latest.status !== "returned" && !(teacher && input.newVersion && latest.status === "published")) {
    const row = teacher ? await teacherSubmissionRow(latest.id, teacher) : await studentSubmissionRow(latest.id, studentAuth!);
    return submissionDetails(row, latest.status === "published" || Boolean(teacher));
  }
  const id = crypto.randomUUID(); const now = Date.now(); const version = Number(latest?.version ?? 0) + 1;
  await appEnv().DB.prepare(`INSERT INTO homework_submissions
    (id, assignment_id, student_id, version, status, submitted_by_type, submitted_by_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
    .bind(id, input.assignmentId, studentId, version, teacher ? "teacher" : "student", teacher?.id ?? studentAuth!.studentId, now, now).run();
  const row = teacher ? await teacherSubmissionRow(id, teacher) : await studentSubmissionRow(id, studentAuth!);
  return submissionDetails(row, Boolean(teacher));
}

export async function replaceSubmissionPages(id: string, pages: Array<{ originalAssetId: string; processedAssetId: string; quality?: unknown }>, actor: AuthUser | StudentAuth) {
  if (!pages.length || pages.length > 100) throw responseError("请上传 1 至 100 页答卷", 400);
  const teacher = "role" in actor ? actor : null;
  const row = teacher ? await teacherSubmissionRow(id, teacher) : await studentSubmissionRow(id, actor as StudentAuth);
  if (row.status !== "draft") throw responseError("当前提交已经锁定，不能修改页面", 409);
  const assetIds = [...new Set(pages.flatMap((page) => [page.originalAssetId, page.processedAssetId]))];
  const placeholders = assetIds.map(() => "?").join(",");
  const assets = await appEnv().DB.prepare(`SELECT id FROM homework_assets WHERE owner_user_id = ? AND upload_submission_id = ?
    AND ${teacher ? "upload_student_id IS NULL" : "upload_student_id = ?"} AND id IN (${placeholders})`)
    .bind(String(row.owner_user_id), id, ...(!teacher ? [(actor as StudentAuth).studentId] : []), ...assetIds).all<{ id: string }>();
  if (assets.results.length !== assetIds.length) throw responseError("部分作业图片不存在或无权使用", 400);
  const roleRows = await appEnv().DB.prepare(`SELECT id, role FROM homework_assets WHERE upload_submission_id = ? AND id IN (${placeholders})`)
    .bind(id, ...assetIds).all<{ id: string; role: string }>();
  const roleById = new Map(roleRows.results.map((asset) => [asset.id, asset.role]));
  if (pages.some((page) => roleById.get(page.originalAssetId) !== "submission_original" || roleById.get(page.processedAssetId) !== "submission_processed")) {
    throw responseError("答卷原件与校准图类型不匹配", 400);
  }
  const previousAssets = await appEnv().DB.prepare(`SELECT homework_assets.id, homework_assets.r2_key FROM submission_pages
    JOIN homework_assets ON homework_assets.id = submission_pages.original_asset_id OR homework_assets.id = submission_pages.processed_asset_id
    WHERE submission_pages.submission_id = ?`).bind(id).all<{ id: string; r2_key: string }>();
  await appEnv().DB.prepare("DELETE FROM submission_pages WHERE submission_id = ?").bind(id).run();
  const now = Date.now();
  for (const [index, page] of pages.entries()) await appEnv().DB.prepare(`INSERT INTO submission_pages
    (id, submission_id, original_asset_id, processed_asset_id, page_order, quality_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), id, page.originalAssetId, page.processedAssetId, index, JSON.stringify(page.quality ?? {}), now).run();
  await appEnv().DB.prepare("UPDATE homework_submissions SET updated_at = ? WHERE id = ?").bind(now, id).run();
  const retained = new Set(assetIds);
  for (const asset of previousAssets.results) if (!retained.has(asset.id)) {
    await homeworkAssetsBucket().delete(asset.r2_key);
    await appEnv().DB.prepare("DELETE FROM homework_assets WHERE id = ?").bind(asset.id).run();
  }
  const updated = teacher ? await teacherSubmissionRow(id, teacher) : await studentSubmissionRow(id, actor as StudentAuth);
  return submissionDetails(updated, Boolean(teacher));
}

async function dispatchSubmissionGrading(id: string, assignmentId: string) {
  const mode = await appEnv().DB.prepare("SELECT input_mode FROM homework_assignments WHERE id=?").bind(assignmentId).first<{input_mode:string}>();
  if (mode?.input_mode === "completed_homework") {
    if (appEnv().HOMEWORK_GRADING_QUEUE) await appEnv().HOMEWORK_GRADING_QUEUE!.send({kind:"grade_submission",submissionId:id});
    else await (await import("./homework-grading")).processHomeworkSubmission(id);
    return;
  }
  const pageRows = await appEnv().DB.prepare("SELECT DISTINCT page_number FROM assignment_questions WHERE assignment_id = ? ORDER BY page_number")
    .bind(assignmentId).all<{ page_number: number }>();
  const messages = pageRows.results.map((row) => ({ kind: "grade_submission_page" as const, submissionId: id, pageNumber: Number(row.page_number) }));
  if (!messages.length) throw responseError("作业模板尚未完成", 409);
  const queue = appEnv().HOMEWORK_GRADING_QUEUE;
  if (queue) {
    if (queue.sendBatch) await queue.sendBatch(messages.map((body) => ({ body })));
    else for (const message of messages) await queue.send(message);
  } else {
    await (await import("./homework-grading")).processHomeworkSubmission(id);
  }
}

export async function submitHomeworkSubmission(id: string, actor: AuthUser | StudentAuth) {
  const teacher = "role" in actor ? actor : null;
  const row = teacher ? await teacherSubmissionRow(id, teacher) : await studentSubmissionRow(id, actor as StudentAuth);
  if (row.status !== "draft") throw responseError("当前提交不能再次提交", 409);
  const assignment = await appEnv().DB.prepare("SELECT status,input_mode FROM homework_assignments WHERE id = ?").bind(String(row.assignment_id)).first<{ status: string; input_mode:string }>();
  const completed = assignment?.input_mode === "completed_homework";
  if (!completed && assignment?.status !== "published") throw responseError("该作业已经关闭，不能继续提交", 409);
  const pageRows = await appEnv().DB.prepare("SELECT page_order, quality_json FROM submission_pages WHERE submission_id = ? ORDER BY page_order")
    .bind(id).all<{ page_order: number; quality_json: string }>();
  if (!pageRows.results.length) throw responseError("请先上传答卷页面", 400);
  const questionCount = await appEnv().DB.prepare("SELECT COUNT(*) AS count FROM assignment_questions WHERE assignment_id = ?").bind(String(row.assignment_id)).first<{ count: number }>();
  if (!completed && !Number(questionCount?.count ?? 0)) throw responseError("作业模板尚未完成", 409);
  if (completed && pageRows.results.length > 30) throw responseError("直接批改单份作业最多 30 页",400);
  const now = Date.now();
  const blockingPages = pageRows.results.map((page) => ({ page, quality: parseJson<{ blocking?: boolean; warnings?: string[] }>(page.quality_json, {}) }))
    .filter((item) => item.quality.blocking);
  if (blockingPages.length && !completed) {
    const detail = blockingPages.flatMap((item) => item.quality.warnings ?? []).filter(Boolean).slice(0, 3).join("；");
    const reason = `第 ${blockingPages.map((item) => Number(item.page.page_order) + 1).join("、")} 页照片质量不足${detail ? `：${detail}` : "，请重新拍摄完整清晰的答卷"}`;
    await appEnv().DB.prepare("UPDATE homework_submissions SET status = 'returned', submitted_at = ?, returned_at = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
      .bind(now, now, reason.slice(0, 500), now, id).run();
    const returned = teacher ? await teacherSubmissionRow(id, teacher) : await studentSubmissionRow(id, actor as StudentAuth);
    return submissionDetails(returned, Boolean(teacher));
  }
  if (completed) await appEnv().DB.prepare("UPDATE homework_assignments SET status='closed',template_confirmed=0 WHERE id=?").bind(row.assignment_id).run();
  await appEnv().DB.prepare("UPDATE homework_submissions SET status = 'submitted', submitted_at = ?, failure_reason = '', updated_at = ? WHERE id = ?")
    .bind(now, now, id).run();
  try { await dispatchSubmissionGrading(id, String(row.assignment_id)); }
  catch (error) {
    await appEnv().DB.prepare("UPDATE homework_submissions SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message.slice(0, 500) : "批改任务提交失败", Date.now(), id).run();
    throw error;
  }
  const updated = teacher ? await teacherSubmissionRow(id, teacher) : await studentSubmissionRow(id, actor as StudentAuth);
  return submissionDetails(updated, Boolean(teacher));
}

export async function retryHomeworkSubmission(id: string, actor: AuthUser | StudentAuth) {
  const teacher = "role" in actor ? actor : null;
  const row = teacher ? await teacherSubmissionRow(id, teacher) : await studentSubmissionRow(id, actor as StudentAuth);
  if (row.status !== "failed") throw responseError("只有处理失败的提交可以重试", 409);
  const now = Date.now();
  await appEnv().DB.prepare("UPDATE homework_submissions SET status = 'submitted', failure_reason = '', updated_at = ? WHERE id = ?")
    .bind(now, id).run();
  try { await dispatchSubmissionGrading(id, String(row.assignment_id)); }
  catch (error) {
    await appEnv().DB.prepare("UPDATE homework_submissions SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message.slice(0, 500) : "批改任务提交失败", Date.now(), id).run();
    throw error;
  }
  const updated = teacher ? await teacherSubmissionRow(id, teacher) : await studentSubmissionRow(id, actor as StudentAuth);
  return submissionDetails(updated, Boolean(teacher));
}

export async function reviewSubmission(id: string, items: Array<Partial<GradingItem> & { id: string }>, user: AuthUser) {
  const row = await teacherSubmissionRow(id, user);
  if (!["review_required", "ready"].includes(String(row.status))) throw responseError("当前提交不在复核阶段", 409);
  const now = Date.now();
  for (const patch of items) {
    if (!VERDICTS.includes(patch.verdict as GradingVerdict)) throw responseError("批改结论无效", 400);
    const resolved = ["correct", "partial", "incorrect", "unreadable"].includes(String(patch.verdict));
    await appEnv().DB.prepare(`UPDATE grading_items SET verdict = ?, student_answer = ?, feedback = ?, error_type = ?, confidence = ?,
      requires_review = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND submission_id = ?`)
      .bind(patch.verdict, text(patch.studentAnswer, 100_000), text(patch.feedback, 4_000), text(patch.errorType, 120),
        Math.max(0, Math.min(1, Number(patch.confidence) || 0)), resolved ? 0 : 1, resolved ? user.id : null, resolved ? now : null, now, patch.id, id).run();
  }
  const unresolved = await appEnv().DB.prepare("SELECT COUNT(*) AS count FROM grading_items WHERE submission_id = ? AND requires_review = 1")
    .bind(id).first<{ count: number }>();
  await appEnv().DB.prepare("UPDATE homework_submissions SET status = ?, updated_at = ? WHERE id = ?")
    .bind(Number(unresolved?.count ?? 0) ? "review_required" : "ready", now, id).run();
  return readTeacherSubmission(id, user);
}

export async function correctPublishedSubmission(id: string, items: Array<Partial<GradingItem> & { id: string }>, user: AuthUser) {
  const row = await teacherSubmissionRow(id, user);
  if (row.status !== "published") throw responseError("只有已发布结果可以修正", 409);
  if (!items.length || items.length > 200) throw responseError("请选择需要修正的题目", 400);
  const now = Date.now();
  for (const patch of items) {
    if (!(["correct", "partial", "incorrect", "unreadable", "review_required"] as GradingVerdict[]).includes(patch.verdict as GradingVerdict)) throw responseError("批改结论无效", 400);
    const existing = await appEnv().DB.prepare(`SELECT g.*,q.answer AS standard_answer,q.analysis AS standard_analysis,q.reference_verified,q.stem FROM grading_items g JOIN assignment_questions q ON q.id=g.assignment_question_id WHERE g.id = ? AND g.submission_id = ?`).bind(patch.id, id).first<Record<string, unknown>>();
    if (!existing) throw responseError("批改项不存在", 404);
    if (patch.standardAnswer?.trim() && (patch.standardAnswer !== existing.standard_answer || patch.standardAnalysis !== existing.standard_analysis || (patch.referenceVerified === true && !Number(existing.reference_verified)))) await appEnv().DB.prepare("UPDATE assignment_questions SET answer=?,analysis=?,reference_source='provided',reference_verified=1,reference_evidence='教师补充并确认参考解答' WHERE id=? AND assignment_id=?")
      .bind(text(patch.standardAnswer,100_000),text(patch.standardAnalysis,100_000),existing.assignment_question_id,row.assignment_id).run();
    if(patch.stem?.trim() && patch.stem !== existing.stem) await appEnv().DB.prepare("UPDATE assignment_questions SET stem=? WHERE id=? AND assignment_id=?").bind(text(patch.stem,100_000),existing.assignment_question_id,row.assignment_id).run();
    const reference = await appEnv().DB.prepare("SELECT reference_verified FROM assignment_questions WHERE id=?").bind(existing.assignment_question_id).first<{reference_verified:number}>();
    if (["correct","partial","incorrect"].includes(String(patch.verdict)) && !reference?.reference_verified) throw responseError("请先补充并确认本题参考答案",400);
    const next = { verdict: patch.verdict, studentAnswer: text(patch.studentAnswer ?? existing.student_answer, 100_000),
      feedback: text(patch.feedback ?? existing.feedback, 4_000), errorType: text(patch.errorType ?? existing.error_type, 120),
      stepAnalysis: patch.stepAnalysis ?? parseJson<string[]>(existing.step_analysis_json, []), evidenceSummary: text(patch.evidenceSummary ?? existing.evidence_summary, 1_000),
      capabilityKeys: patch.capabilityKeys ?? parseJson<string[]>(existing.capability_keys_json, []), confidence: Math.max(0, Math.min(1, Number(patch.confidence ?? existing.confidence) || 0)) };
    await appEnv().DB.batch([
      appEnv().DB.prepare(`INSERT INTO grading_item_revisions (id, grading_item_id, submission_id, corrected_by, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), patch.id, id, user.id, JSON.stringify(existing), JSON.stringify(next), now),
      appEnv().DB.prepare(`UPDATE grading_items SET verdict = ?, student_answer = ?, feedback = ?, error_type = ?, step_analysis_json = ?,
        evidence_summary = ?, capability_keys_json = ?, confidence = ?, requires_review = ?, reviewed_by = ?, reviewed_at = ?, corrected_at = ?,
        wrong_book_applied_at = NULL, updated_at = ? WHERE id = ? AND submission_id = ?`)
        .bind(next.verdict, next.studentAnswer, next.feedback, next.errorType, JSON.stringify(next.stepAnalysis), next.evidenceSummary,
          JSON.stringify(next.capabilityKeys), next.confidence, ["unreadable","review_required"].includes(String(next.verdict)) ? 1 : 0, user.id, now, now, now, patch.id, id),
    ]);

  }
  const { generateSubmissionReport } = await import("./homework-grading"); await generateSubmissionReport(id);
  const submission = await readTeacherSubmission(id, user); await (await import("./homework-wrong-book")).syncSubmissionWrongBook(submission, user);
  return readTeacherSubmission(id, user);
}


export async function publishSubmission(id: string, user: AuthUser) {
  const row = await teacherSubmissionRow(id, user);
  if(row.input_mode === "completed_homework") { try { await (await import("./homework-page-coverage")).assertCompletePageCoverage(id); } catch(error) { throw responseError(error instanceof Error?error.message:"页面尚未全部核验",409); } }
  if (row.status === "published") { const submission = await readTeacherSubmission(id, user); await (await import("./homework-wrong-book")).syncSubmissionWrongBook(submission, user); return readTeacherSubmission(id, user); }
  if (row.status !== "ready") throw responseError("仍有题目需要复核，暂不能发布", 409);
  let submission = await submissionDetails(row);
  if (!submission.gradingItems.length) throw responseError("没有可发布的批改结果", 409);
  if (!submission.report) {
    const { generateSubmissionReport } = await import("./homework-grading"); await generateSubmissionReport(id); submission = await submissionDetails(row);
  }
  await (await import("./homework-wrong-book")).syncSubmissionWrongBook(submission, user);
  const now = Date.now();
  await appEnv().DB.prepare("UPDATE homework_submissions SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?")
    .bind(now, now, id).run();
  return readTeacherSubmission(id, user);
}

export async function autoPublishSubmission(id: string) {
  const row = await appEnv().DB.prepare(`SELECT homework_assignments.owner_user_id FROM homework_submissions
    JOIN homework_assignments ON homework_assignments.id = homework_submissions.assignment_id WHERE homework_submissions.id = ?`)
    .bind(id).first<{ owner_user_id: string }>();
  if (!row) throw responseError("提交记录不存在", 404);
  return publishSubmission(id, { id: row.owner_user_id, email: "", role: "member" });
}

export async function publishReadyAssignmentSubmissions(assignmentId: string, user: AuthUser) {
  if (assignmentId) await ownedAssignment(assignmentId, user);
  const rows = await appEnv().DB.prepare(`${SUBMISSION_SELECT} WHERE homework_assignments.owner_user_id = ? ${assignmentId ? "AND homework_submissions.assignment_id = ?" : ""} ORDER BY homework_submissions.updated_at DESC`)
    .bind(...(assignmentId ? [user.id, assignmentId] : [user.id])).all<Record<string, unknown>>();
  if (!rows.results.length) throw responseError("当前作业还没有可发布的提交", 409);
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of rows.results) if (!latest.has(String(row.student_id))) latest.set(String(row.student_id), row);
  const blocked = [...latest.values()].filter((row) => !["ready", "published"].includes(String(row.status)));
  if (blocked.length) throw responseError(`仍有 ${blocked.length} 名学生的最新提交未完成复核`, 409);
  let published = 0;
  for (const row of latest.values()) if (row.status === "ready") { await publishSubmission(String(row.id), user); published += 1; }
  return { published, total: latest.size };
}

export async function returnSubmission(id: string, reason: string, user: AuthUser) {
  const row = await teacherSubmissionRow(id, user);
  if (row.status === "published") throw responseError("已发布结果不能退回重拍", 409);
  const now = Date.now();
  await appEnv().DB.prepare("UPDATE homework_submissions SET status = 'returned', returned_at = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
    .bind(now, text(reason, 500) || "请重新拍摄清晰完整的答卷", now, id).run();
  return readTeacherSubmission(id, user);
}

export async function reprocessPendingSubmission(id:string, replacements:Array<{replacePageId?:string;originalAssetId:string;processedAssetId:string;quality?:unknown}>,user:AuthUser) {
  const row=await teacherSubmissionRow(id,user);
  if(row.status!=="published") throw responseError("请等待本次批改完成后再补充",409);
  const pending=await appEnv().DB.prepare("SELECT assignment_question_id FROM grading_items WHERE submission_id=? AND (requires_review=1 OR verdict IN ('unreadable','review_required'))").bind(id).all<{assignment_question_id:string}>();
  const coverage=row.input_mode === "completed_homework" ? await (await import("./homework-page-coverage")).readPageCoverage(id):null;
  const pendingPages=coverage?.pages.filter(p=>p.kind==='unreadable').map(p=>`page:${p.pageNumber}`)??[];
  if(!pending.results.length && !pendingPages.length)throw responseError("没有待处理的题目",409);
  const changes:D1PreparedStatement[]=[]; const now=Date.now();
  for(const replacement of replacements){
    const page=await appEnv().DB.prepare('SELECT * FROM submission_pages WHERE id=? AND submission_id=?').bind(replacement.replacePageId,id).first<Record<string,unknown>>();
    if(!page)throw responseError("补图对应的原页面不存在",400);
    const assets=await appEnv().DB.prepare("SELECT id,role FROM homework_assets WHERE owner_user_id=? AND upload_submission_id=? AND id IN (?,?)")
      .bind(user.id,id,replacement.originalAssetId,replacement.processedAssetId).all<{id:string;role:string}>();
    if(!assets.results.some(a=>a.id===replacement.originalAssetId&&a.role==='submission_original')||!assets.results.some(a=>a.id===replacement.processedAssetId&&a.role==='submission_processed'))throw responseError("补图图片不存在或无权使用",400);
    changes.push(appEnv().DB.prepare('INSERT INTO submission_page_revisions(id,submission_id,page_id,original_asset_id,processed_asset_id,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),id,page.id,page.original_asset_id,page.processed_asset_id,now));
    changes.push(appEnv().DB.prepare('UPDATE submission_pages SET original_asset_id=?,processed_asset_id=?,quality_json=? WHERE id=? AND submission_id=?').bind(replacement.originalAssetId,replacement.processedAssetId,JSON.stringify(replacement.quality??{}),page.id,id));
  }
  changes.push(appEnv().DB.prepare("UPDATE homework_submissions SET status='submitted',submitted_at=?,reprocess_question_ids_json=?,updated_at=? WHERE id=?").bind(now,JSON.stringify([...pending.results.map(p=>p.assignment_question_id),...pendingPages]),now,id));
  if(row.input_mode==='completed_homework')changes.push(appEnv().DB.prepare('UPDATE homework_assignments SET template_confirmed=0 WHERE id=?').bind(row.assignment_id));
  await appEnv().DB.batch(changes);
  await dispatchSubmissionGrading(id,String(row.assignment_id));
  return readTeacherSubmission(id,user);
}

export async function rebuildSubmissionCoverage(id:string,user:AuthUser){
  const row=await teacherSubmissionRow(id,user);
  if(row.input_mode!=="completed_homework")throw responseError("此操作仅用于直接上传的作业",400);
  if(!["published","ready","failed"].includes(String(row.status)))throw responseError("请等待当前批改完成",409);
  const now=Date.now();
  const claimed=await appEnv().DB.prepare("UPDATE homework_submissions SET status='submitted',submitted_at=?,reprocess_question_ids_json='[]',failure_reason='',updated_at=? WHERE id=? AND status IN ('published','ready','failed')").bind(now,now,id).run();
  if(!claimed.meta.changes)return readTeacherSubmission(id,user);
  const previous=await appEnv().DB.prepare('SELECT * FROM grading_items WHERE submission_id=?').bind(id).all<Record<string,unknown>>();
  for(const item of previous.results)await appEnv().DB.prepare('INSERT INTO grading_item_revisions(id,grading_item_id,submission_id,corrected_by,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(),item.id,id,user.id,JSON.stringify(item),JSON.stringify({action:"rebuild-coverage",reason:"补全未处理页面，保留修复前记录"}),now).run();
  await appEnv().DB.prepare('UPDATE homework_assignments SET template_confirmed=0 WHERE id=?').bind(row.assignment_id).run();
  try{await dispatchSubmissionGrading(id,String(row.assignment_id));}catch(error){await appEnv().DB.prepare("UPDATE homework_submissions SET status='failed',failure_reason=?,updated_at=? WHERE id=?").bind(error instanceof Error?error.message:'无法提交补全任务',Date.now(),id).run();throw error;}
  return readTeacherSubmission(id,user);
}

export async function updateSubmission(id: string, body: { action?: string; pages?: Array<{ originalAssetId: string; processedAssetId: string; quality?: unknown; replacePageId?:string }>; items?: Array<Partial<GradingItem> & { id: string }>; reason?: string }, actor: AuthUser | StudentAuth) {
  if (body.action === "save-pages") return replaceSubmissionPages(id, body.pages ?? [], actor);
  if (body.action === "submit") return submitHomeworkSubmission(id, actor);
  if (body.action === "retry") return retryHomeworkSubmission(id, actor);
  if (!("role" in actor)) throw responseError("学生无权执行该操作", 403);
  if (body.action === "rebuild-coverage") return rebuildSubmissionCoverage(id,actor);
  if (body.action === "reprocess-pending") return reprocessPendingSubmission(id,body.pages??[],actor);
  if (body.action === "review") return reviewSubmission(id, body.items ?? [], actor);
  if (body.action === "correct") return correctPublishedSubmission(id, body.items ?? [], actor);
  if (body.action === "publish") return publishSubmission(id, actor);
  if (body.action === "return") return returnSubmission(id, body.reason ?? "", actor);
  throw responseError("未知的提交操作", 400);
}

export async function studentWrongBook(student: StudentAuth) {
  const { readWrongQuestions } = await import("./student-wrong-book");
  return readWrongQuestions(student.studentId, { id: student.ownerUserId, email: "", role: "member" });
}

export async function deleteStudentHomeworkAssets(studentId: string, ownerUserId: string) {
  const rows = await appEnv().DB.prepare(`SELECT DISTINCT homework_assets.id, homework_assets.r2_key FROM homework_assets
    WHERE homework_assets.owner_user_id = ? AND (homework_assets.upload_student_id = ? OR homework_assets.upload_submission_id IN (SELECT id FROM homework_submissions WHERE student_id=?) OR homework_assets.id IN (
      SELECT original_asset_id FROM submission_pages JOIN homework_submissions ON homework_submissions.id = submission_pages.submission_id WHERE homework_submissions.student_id = ?
      UNION SELECT processed_asset_id FROM submission_pages JOIN homework_submissions ON homework_submissions.id = submission_pages.submission_id WHERE homework_submissions.student_id = ?
      UNION SELECT answer_crop_asset_id FROM student_wrong_questions WHERE student_id = ? AND answer_crop_asset_id IS NOT NULL
    ))`)
    .bind(ownerUserId, studentId, studentId, studentId, studentId, studentId).all<{ id: string; r2_key: string }>();
  return rows.results;
}

export async function deleteHomeworkAssetRows(assets: Array<{ id: string; r2_key: string }>, ownerUserId: string) {
  for (const asset of assets) await appEnv().DB.prepare("DELETE FROM homework_assets WHERE id = ? AND owner_user_id = ?").bind(asset.id, ownerUserId).run();
  await scheduleHomeworkAssetCleanup(ownerUserId, assets.map((asset) => asset.r2_key));
}

const ANSWER_RECOVERY_BATCH_SIZE = 4;

async function recoverAssignmentAnswers(input: {
  extracted: ExtractedAssignmentQuestion[];
  answerImages: string[];
  callModel: (modelInput: { images: string[]; prompt: string; schema: Record<string, unknown>; schemaName: string }) => Promise<{ text?: string; status: number; error?: string }>;
  parseModelText: (value: string) => unknown;
}) {
  let merged = input.extracted;
  let pending = incompleteAssignmentAnswers(merged);
  if (!pending.length) return merged;

  async function recoverBatch(pageStart: number, pageEnd: number, questions: ExtractedAssignmentQuestion[]) {
    const result = await input.callModel({
      images: input.answerImages.slice(pageStart, pageEnd),
      prompt: buildAssignmentAnswerRecoveryPrompt(questions, pageStart, pageEnd),
      schema: assignmentAnswerRecoverySchema,
      schemaName: "homework_assignment_answer_recovery",
    });
    if (!result.text) return [];
    return normalizeAssignmentAnswerRecovery(input.parseModelText(result.text));
  }

  try {
    const recovered = await recoverBatch(0, input.answerImages.length, pending);
    merged = mergeAssignmentAnswerRecovery(merged, recovered);
  } catch {
    // Keep the original extraction available for teacher review if a recovery call fails.
  }
  pending = incompleteAssignmentAnswers(merged);
  for (let pageStart = 0; pageStart < input.answerImages.length && pending.length; pageStart += ANSWER_RECOVERY_BATCH_SIZE) {
    const pageEnd = Math.min(input.answerImages.length, pageStart + ANSWER_RECOVERY_BATCH_SIZE);
    try {
      const recovered = await recoverBatch(pageStart, pageEnd, pending);
      if (recovered.length) merged = mergeAssignmentAnswerRecovery(merged, recovered);
    } catch {
      // A later batch may still contain the answer; unresolved items remain blocked for review.
    }
    pending = incompleteAssignmentAnswers(merged);
  }
  return merged;
}

export async function extractAssignmentTemplate(id: string, user: AuthUser) {
  const assignment = await readAssignment(id, user);
  if (assignment.status !== "draft") throw responseError("已发布作业不能重新识别模板", 409);
  const questionAssets = assignment.assets.filter((asset) => asset.role === "question").sort((a, b) => a.pageOrder - b.pageOrder);
  const answerAssets = assignment.assets.filter((asset) => asset.role === "answer").sort((a, b) => a.pageOrder - b.pageOrder);
  if (!questionAssets.length || !answerAssets.length) throw responseError("请先上传空白题目卷和答案解析", 400);
  if (questionAssets.length + answerAssets.length > 30) throw responseError("题目卷和答案解析合计不能超过 30 页", 400);
  const { assignmentExtractionSchema, buildAssignmentExtractionPrompt, normalizeAssignmentExtraction } = await import("../homework-grading-contract");
  const { callRecognitionModel, parseRecognitionModelText } = await import("./recognition-model");
  const { homeworkAssetDataUrl } = await import("./homework-assets");
  const images = await Promise.all([...questionAssets, ...answerAssets].map((asset) => homeworkAssetDataUrl(asset.id)));
  const result = await callRecognitionModel({ images, prompt: buildAssignmentExtractionPrompt(questionAssets.length, answerAssets.length),
    schema: assignmentExtractionSchema, schemaName: "homework_assignment_extraction" });
  if (!result.text) throw responseError(result.error || "模板识别没有返回可用结果", result.status >= 400 ? result.status : 502);
  let extracted = normalizeAssignmentExtraction(parseRecognitionModelText(result.text));
  if (!extracted.length) throw responseError("没有从题目卷中识别到试题", 422);
  if (incompleteAssignmentAnswers(extracted).length) {
    extracted = await recoverAssignmentAnswers({
      extracted,
      answerImages: images.slice(questionAssets.length),
      callModel: callRecognitionModel,
      parseModelText: parseRecognitionModelText,
    });
  }
  await replaceAssignmentQuestions(id, extracted.map((question, index) => ({
    id: crypto.randomUUID(), assignmentId: id, questionNumber: question.question_number, pageNumber: question.page_number,
    type: question.type, stem: question.stem, options: question.options, answer: question.answer, analysis: question.analysis,
    bbox: question.bbox, confidence: question.confidence, warnings: question.warnings, knowledgeTags: question.knowledge_tags,
    // Resolved against the published graph inside replaceAssignmentQuestions.
    taxonomyKeys: [], capabilityKeys: question.capability_keys, sortOrder: index,
  })), user);
  return readAssignment(id, user);
}

export function homeworkDb() { return appEnv().DB; }
export function isSubmissionStatus(value: unknown): value is SubmissionStatus { return SUBMISSION_STATUSES.has(value as SubmissionStatus); }
export function isAssignmentStatus(value: unknown) { return ASSIGNMENT_STATUSES.has(String(value)); }
