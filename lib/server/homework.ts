import { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AssignedHomework, AssignmentQuestion, AuthUser, GradingItem, GradingVerdict, HomeworkCurriculum, HomeworkDay, HomeworkSheetGroup, HomeworkSubmission, HomeworkSubmissionListItem, Question, QuestionType,
  StudentHomework, SubmissionPage, SubmissionStatus,
} from "../types";
import { homeworkAssetsBucket, requireHomeworkEnabled, scheduleHomeworkAssetCleanup } from "./homework-assets";
import { normalizeHomeworkOutputs } from "./homework-outputs";
import { homeworkProgress, isPendingGradingItem, normalizeMaxScore, reconcileHomeworkScore, summarizeHomeworkScore } from "../homework-grading-rules.mjs";
import { resolveKnowledgeTaxonomyKeys } from "../homework-capability-framework.mjs";

type HomeworkQueueMessage =
  | { kind: "grade_submission"; submissionId: string }
  | { kind: "cleanup_homework_assets"; jobId: string };
type HomeworkQueue = { send(message: HomeworkQueueMessage): Promise<void> };
type AppEnv = { DB: D1Database; HOMEWORK_GRADING_QUEUE?: HomeworkQueue };
const QUESTION_TYPES: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];
const VERDICTS: GradingVerdict[] = ["correct", "partial", "incorrect", "unreadable", "review_required"];
const gradingRun = new AsyncLocalStorage<{ db: D1Database; signal: AbortSignal }>();

export function homeworkGradingSignal() { return gradingRun.getStore()?.signal; }

/** Fence the existing grading writes in the same D1 transaction as the ownership check.
 * Request handlers outside this run continue using the original binding unchanged. */
export function withHomeworkGradingRun<T>(id: string, token: string, signal: AbortSignal, work: () => Promise<T>) {
  const database = (env as unknown as AppEnv).DB;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const batch = async (statements: D1PreparedStatement[]) => {
    signal.throwIfAborted();
    if (!statements.length) return [];
    const guard = database.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM homework_submissions s JOIN homework_assignments a ON a.id = s.assignment_id
      WHERE s.id = ? AND s.grading_run_id = ? AND s.status IN ('processing','ready','published') AND a.status <> 'archived'
    ) THEN 1 ELSE json_extract('grading run no longer owns submission', '$') END AS valid`).bind(id, token);
    return (await database.batch([guard, ...statements.map(statement => originals.get(statement) ?? statement)])).slice(1);
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: Parameters<D1PreparedStatement["bind"]>) => wrap(target.bind(...values));
        if (key === "run" || key === "all") return async () => (await batch([target]))[0];
        if (key === "first") return async (column?: string) => {
          const row = (await batch([target]))[0].results[0] as Record<string, unknown> | undefined;
          return column === undefined ? row ?? null : row?.[column] ?? null;
        };
        // Grading never uses raw writes; do not leave a way to bypass the fence.
        if (key === "raw") return () => { throw new Error("批改写入请使用 run、all 或 first"); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  const guarded = new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => /^\s*SELECT\b/i.test(sql) ? target.prepare(sql) : wrap(target.prepare(sql));
      if (key === "batch") return batch;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return gradingRun.run({ db: guarded, signal }, work);
}

function appEnv(): AppEnv {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  const run = gradingRun.getStore();
  return run ? { ...bindings, DB: run.db } : bindings;
}

function responseError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return value == null ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; }
}
function text(value: unknown, limit: number) { return String(value ?? "").trim().slice(0, limit); }
export function homeworkCurriculum(value: unknown): HomeworkCurriculum { return value === "international" ? "international" : "school"; }
// Figures cut from the homework page when the question was read; only stored crops are shown.
function questionFigures(evidence: unknown) {
  const figures = parseJson<{ figures?: Array<{ kind?: string; assetId?: unknown; width?: number; height?: number; hasHandwriting?: boolean }> }>(evidence, {}).figures;
  return Array.isArray(figures) ? figures.filter((figure) => typeof figure.assetId === "string")
    .map((figure) => ({ url: `/api/homework-assets/${figure.assetId}`, kind: figure.kind === "options" ? "options" as const : "stem" as const, width: figure.width, height: figure.height, hasHandwriting: figure.hasHandwriting })) : [];
}

async function ownedStudent(studentId: string, ownerUserId: string) {
  const row = await appEnv().DB.prepare("SELECT id, name FROM students WHERE id = ? AND owner_user_id = ?")
    .bind(studentId, ownerUserId).first<{ id: string; name: string }>();
  if (!row) throw responseError("学生档案不存在", 404);
  return row;
}

function assignmentQuestion(row: Record<string, unknown>): AssignmentQuestion {
  return {
    id: String(row.id), assignmentId: String(row.assignment_id), questionNumber: String(row.question_number), pageNumber: Number(row.page_number),
    type: QUESTION_TYPES.includes(row.type as QuestionType) ? row.type as QuestionType : "解答题", stem: String(row.stem),
    options: parseJson<string[]>(row.options_json, []), answer: String(row.answer ?? ""), analysis: String(row.analysis ?? ""),
    bbox: parseJson(row.bbox_json, null), confidence: Number(row.confidence), warnings: parseJson<string[]>(row.warnings_json, []),
    knowledgeTags: parseJson<string[]>(row.knowledge_tags_json, []), taxonomyKeys: parseJson<string[]>(row.taxonomy_keys_json, []),
    capabilityKeys: parseJson<string[]>(row.capability_keys_json, []), figures: questionFigures(row.input_evidence_json),
    referenceSource: row.reference_source as AssignmentQuestion["referenceSource"], referenceVerified: Number(row.reference_verified) === 1, referenceEvidence: String(row.reference_evidence ?? ""),
    source: row.source_json ? parseJson<Question | null>(row.source_json, null) : null,
    sortOrder: Number(row.sort_order), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

/** The questions read from one uploaded homework, with their reference answers. */
export async function readAssignmentQuestions(assignmentId: string, user: AuthUser) {
  const rows = await appEnv().DB.prepare(`SELECT assignment_questions.* FROM assignment_questions
    JOIN homework_assignments ON homework_assignments.id = assignment_questions.assignment_id
    WHERE assignment_questions.assignment_id = ? AND homework_assignments.owner_user_id = ? ORDER BY assignment_questions.sort_order`)
    .bind(assignmentId, user.id).all<Record<string, unknown>>();
  return rows.results.map(assignmentQuestion);
}

function submissionPage(row: Record<string, unknown>): SubmissionPage {
  const rotation = parseJson<{ rotation?: unknown }>(row.quality_json, {}).rotation;
  return {
    id: String(row.id), submissionId: String(row.submission_id), pageOrder: Number(row.page_order),
    originalAssetId: String(row.original_asset_id), processedAssetId: String(row.processed_asset_id),
    originalUrl: `/api/homework-assets/${row.original_asset_id}`, processedUrl: `/api/homework-assets/${row.processed_asset_id}`,
    ...([0, 90, 180, 270].includes(rotation as number) ? { rotation: rotation as SubmissionPage["rotation"] } : {}),
    createdAt: Number(row.created_at),
  };
}

const TEACHER_MARKS = ["correct", "partial", "incorrect"] as const;
function teacherMark(evidenceJson: unknown): GradingItem["teacherMark"] {
  const mark = parseJson<{ teacher_mark?: unknown }>(evidenceJson, {}).teacher_mark;
  return TEACHER_MARKS.find((value) => value === mark) ?? null;
}

function gradingItem(row: Record<string, unknown>, assigned = false): GradingItem {
  // Apply the current assigned-school rule to historical results without rewriting their stored evidence.
  if (assigned && ["partial", "unreadable", "review_required"].includes(String(row.verdict))) row = { ...row, verdict: "incorrect", requires_review: 0,
    score: null, error_type: "", step_analysis_json: "[]", evidence_summary: "" };
  return {
    id: String(row.id), submissionId: String(row.submission_id), assignmentQuestionId: String(row.assignment_question_id),
    pageId: row.page_id == null ? null : String(row.page_id), questionNumber: String(row.question_number), questionType: row.question_type as QuestionType,
    referenceSource: row.reference_source as GradingItem["referenceSource"], referenceVerified: Number(row.reference_verified) === 1, referenceEvidence: String(row.reference_evidence ?? ""),
    stem: String(row.stem), figures: questionFigures(row.question_evidence_json), teacherMark: teacherMark(row.question_evidence_json), standardAnswer: String(row.standard_answer), standardAnalysis: String(row.standard_analysis),
    verdict: VERDICTS.includes(row.verdict as GradingVerdict) ? row.verdict as GradingVerdict : "review_required",
    score: row.score == null ? null : Number(row.score), maxScore: normalizeMaxScore(parseJson<{ max_score?: unknown }>(row.question_evidence_json, {}).max_score),
    studentAnswer: String(row.student_answer ?? ""), feedback: String(row.feedback ?? ""), errorType: String(row.error_type ?? ""),
    stepAnalysis: parseJson<string[]>(row.step_analysis_json, []), evidenceSummary: String(row.evidence_summary ?? ""),
    capabilityKeys: parseJson<string[]>(row.capability_keys_json, []),
    confidence: Number(row.confidence), bbox: parseJson(row.bbox_json, null), requiresReview: Number(row.requires_review) === 1,
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at), correctedAt: row.corrected_at == null ? null : Number(row.corrected_at),
    wrongBookAppliedAt: row.wrong_book_applied_at == null ? null : Number(row.wrong_book_applied_at),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

// One upload's grading results with the question each one grades, in sheet order.
function gradingRows(submissionId: string) {
  return appEnv().DB.prepare(`SELECT grading_items.*, assignment_questions.question_number, assignment_questions.type AS question_type,
      assignment_questions.stem, assignment_questions.input_evidence_json AS question_evidence_json, assignment_questions.answer AS standard_answer, assignment_questions.analysis AS standard_analysis, assignment_questions.reference_source, assignment_questions.reference_verified, assignment_questions.reference_evidence
    FROM grading_items JOIN assignment_questions ON assignment_questions.id = grading_items.assignment_question_id
    WHERE grading_items.submission_id = ? ORDER BY assignment_questions.sort_order`).bind(submissionId).all<Record<string, unknown>>();
}

// The results an upload's page and 作业批改's list count: questions a later reading of its pages no longer finds drop
// out, and an assigned school homework is judged right or wrong only.
function uploadGradingItems(rows: Array<Record<string, unknown>>, recognized: Set<unknown> | null, row: Record<string, unknown>) {
  const assignedSchool = Boolean(row.sheet_json) && homeworkCurriculum(row.curriculum) === "school";
  return rows.filter((item) => !recognized || recognized.has(String(item.question_number)) || [...recognized].some((number) => String(item.question_number).startsWith(`${number}(`)))
    .map((item) => gradingItem(item, assignedSchool));
}

function gradingSummary(gradingItems: GradingItem[]): NonNullable<HomeworkSubmission["gradingSummary"]> {
  const settledItems = gradingItems.filter((item) => !isPendingGradingItem(item));
  return { correct: settledItems.filter(i => i.verdict === "correct").length, partial: settledItems.filter(i => i.verdict === "partial").length, incorrect: settledItems.filter(i => i.verdict === "incorrect").length, unresolved: gradingItems.length - settledItems.length, archived: gradingItems.filter(i => i.verdict === "incorrect" && !i.requiresReview && (i.referenceVerified || i.teacherMark === "incorrect") && i.wrongBookAppliedAt != null).length, marks: summarizeHomeworkScore(gradingItems) };
}

async function submissionDetails(row: Record<string, unknown>): Promise<HomeworkSubmission> {
  const id = String(row.id);
  const [pages, grading, report, revisions, questionOriginals] = await Promise.all([
    appEnv().DB.prepare("SELECT * FROM submission_pages WHERE submission_id = ? ORDER BY page_order").bind(id).all<Record<string, unknown>>(),
    gradingRows(id),
    import("./homework-reports").then(({ readSubmissionReport }) => readSubmissionReport(id)),
    appEnv().DB.prepare("SELECT * FROM submission_page_revisions WHERE submission_id=? ORDER BY created_at").bind(id).all<Record<string,unknown>>(),
    appEnv().DB.prepare("SELECT a.id,a.original_name FROM assignment_assets aa JOIN homework_assets a ON a.id=aa.asset_id WHERE aa.assignment_id=? AND aa.role='question' ORDER BY aa.page_order").bind(row.assignment_id).all<{id:string;original_name:string}>(),
  ]);
  const pageCoverage = await (await import("./homework-page-coverage")).readPageCoverage(id);
  const recognized=await (await import("./homework-page-coverage")).readRecognizedQuestionNumbers(id);
  const assigned = await assignedHomework(row);
  // An assigned sheet lists every question from the start; until the pages are read, none of them is identified yet.
  const inventory=recognized?JSON.stringify([...recognized]):assigned?"[]":null;
  const processingProgress = await appEnv().DB.prepare(`SELECT
    (SELECT COUNT(*) FROM assignment_questions WHERE assignment_id=? AND (? IS NULL OR question_number IN (SELECT value FROM json_each(?)))) AS identified,
    (SELECT COUNT(*) FROM assignment_questions WHERE assignment_id=? AND (? IS NULL OR question_number IN (SELECT value FROM json_each(?))) AND ((reference_fingerprint<>'' AND reference_fingerprint NOT LIKE 'pending:%') OR reference_evidence LIKE '教师补充并确认%' OR (source_json<>'' AND reference_verified=1) OR json_extract(input_evidence_json,'$.question_complete')=0 OR (json_extract(input_evidence_json,'$.teacher_mark')='correct' AND NOT EXISTS (SELECT 1 FROM grading_items g WHERE g.assignment_question_id=assignment_questions.id AND g.submission_id=? AND g.verdict IN ('incorrect','partial'))))) AS referenceChecked,
    (SELECT COUNT(*) FROM grading_items g JOIN assignment_questions q ON q.id=g.assignment_question_id WHERE g.submission_id=? AND (? IS NULL OR q.question_number IN (SELECT value FROM json_each(?))) AND (g.updated_at>=? OR (g.reviewed_at IS NOT NULL AND g.requires_review=0))) AS graded`)
    .bind(row.assignment_id,inventory,inventory,row.assignment_id,inventory,inventory,id,id,inventory,inventory,row.submitted_at??0).first<{identified:number;referenceChecked:number;graded:number}>() ?? undefined;
  // Questions read before figures were located; their figures can be filled in from the submission page.
  const figuresPending = Number((await appEnv().DB.prepare(`SELECT COUNT(*) AS count FROM assignment_questions
    WHERE assignment_id=? AND (? IS NULL OR question_number IN (SELECT value FROM json_each(?))) AND json_type(input_evidence_json,'$.page_numbers')='array' AND json_type(input_evidence_json,'$.figures') IS NULL`).bind(row.assignment_id,inventory,inventory).first<{count:number}>())?.count ?? 0);
  const gradingItems = uploadGradingItems(grading.results, recognized, row);
  return {
    outputs: normalizeHomeworkOutputs(parseJson(row.outputs_json, {})),
    curriculum: homeworkCurriculum(row.curriculum),
    processingProgress,
    pageCoverage,
    figuresPending,
    gradingSummary: gradingSummary(gradingItems),
    id, assignmentId: String(row.assignment_id), assignmentTitle: String(row.assignment_title), studentId: String(row.student_id), studentName: String(row.student_name),
    version: Number(row.version), status: row.status as SubmissionStatus,
    submittedAt: row.submitted_at == null ? null : Number(row.submitted_at), publishedAt: row.published_at == null ? null : Number(row.published_at),
    failureReason: String(row.failure_reason ?? ""),
    questionOriginals: (questionOriginals.results as Array<{id:string;original_name:string}>).map(d=>({name:d.original_name,url:`/api/homework-assets/${d.id}`})),
    pageRevisions: revisions.results.map(r=>({pageId:String(r.page_id),originalUrl:`/api/homework-assets/${r.original_asset_id}`,processedUrl:`/api/homework-assets/${r.processed_asset_id}`,createdAt:Number(r.created_at)})),
    pages: pages.results.map(submissionPage), gradingItems, report, assigned,
    questionScope: parseJson<string[]>(row.reprocess_question_ids_json, []),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

type UploadRow = { id: string; version: number; status: SubmissionStatus; created_at: number; submitted_at: number | null; page_count: number };
type ResultRow = { assignment_question_id: string; question_number: string; verdict: GradingVerdict; requires_review: number; standard_answer: string; reference_verified: number; question_evidence_json: string };

// The published results of one upload, without questions a later reading of its pages no longer finds.
async function uploadResults(submissionId: string, assigned = false) {
  const [rows, recognized] = await Promise.all([
    appEnv().DB.prepare(`SELECT g.assignment_question_id, q.question_number, g.verdict, g.requires_review,
        q.answer AS standard_answer, q.reference_verified, q.input_evidence_json AS question_evidence_json FROM grading_items g
      JOIN assignment_questions q ON q.id = g.assignment_question_id WHERE g.submission_id = ?`).bind(submissionId).all<ResultRow>(),
    import("./homework-page-coverage").then(({ readRecognizedQuestionNumbers }) => readRecognizedQuestionNumbers(submissionId)),
  ]);
  return (rows.results as ResultRow[])
    .filter((row) => !recognized || recognized.has(row.question_number) || [...recognized].some((number) => row.question_number.startsWith(`${number}(`)))
    .map((row) => assigned && ["partial", "unreadable", "review_required"].includes(row.verdict) ? { ...row, verdict: "incorrect" as const, requires_review: 0 } : row)
    .map((row) => ({ assignmentQuestionId: row.assignment_question_id,
      verdict: VERDICTS.includes(row.verdict) ? row.verdict : "review_required" as GradingVerdict,
      requiresReview: Number(row.requires_review) === 1, teacherMark: teacherMark(row.question_evidence_json),
      standardAnswer: String(row.standard_answer ?? ""), referenceVerified: Number(row.reference_verified) === 1 }));
}

// Task groups and the 快速排版 record they were assigned from. Legacy start dates are ignored.
type HomeworkSheet = { groups?: HomeworkSheetGroup[]; recordId?: string };

// How the results so far add up: graded ones as right or wrong, and those a teacher still has to look at.
function tally(results: Array<Parameters<typeof isPendingGradingItem>[0]>) {
  const settled = results.filter((result) => !isPendingGradingItem(result));
  return {
    done: results.length,
    correct: settled.filter((result) => result.verdict === "correct").length,
    incorrect: settled.filter((result) => result.verdict === "incorrect" || result.verdict === "partial").length,
    pending: results.length - settled.length,
  };
}

/**
 * An assigned homework comes back in as many uploads as the student hands it in: each question shows its result from
 * the latest published upload that found it, and a question no upload found yet has none (未提交, not wrong).
 * Each day is a task group, handed in when the first upload that found any of its questions was.
 * Lists that only count results pass bodies = false: they skip each question's stored copy, by far the largest column.
 */
async function assignedHomework(row: Record<string, unknown>, bodies = true): Promise<AssignedHomework | null> {
  if (!row.sheet_json) return null;
  const [questions, uploads] = await Promise.all([
    // A question's ID now (it may have got one after it was handed out) goes with it, so a printed export shows it.
    appEnv().DB.prepare(`SELECT id, question_number${bodies ? ", source_json, (SELECT printf('%04d', number) FROM question_codes WHERE question_id = NULLIF(question_key, '')) AS code" : ""}
      FROM assignment_questions WHERE assignment_id = ? AND source_json <> '' ORDER BY sort_order`)
      .bind(row.assignment_id).all<{ id: string; question_number: string; source_json?: string; code?: string | null }>(),
    appEnv().DB.prepare(`SELECT id, version, status, created_at, submitted_at, (SELECT COUNT(*) FROM submission_pages p WHERE p.submission_id = s.id) AS page_count
      FROM homework_submissions s WHERE assignment_id = ? AND student_id = ? ORDER BY version`).bind(row.assignment_id, row.student_id).all<UploadRow>(),
  ]);
  const sheet = questions.results as Array<{ id: string; question_number: string; source_json?: string; code?: string | null }>, handedIn = uploads.results as UploadRow[];
  const results = new Map<string, NonNullable<AssignedHomework["questions"][number]["result"]>>();
  const firstHandedIn = new Map<string, { at: number; result: NonNullable<AssignedHomework["questions"][number]["result"]> }>();
  for (const upload of handedIn.filter((item) => item.status === "published")) {
    for (const result of await uploadResults(upload.id, homeworkCurriculum(row.curriculum) === "school")) {
      const { assignmentQuestionId, ...grading } = result;
      const previous = results.get(assignmentQuestionId);
      const wasIncorrect = previous?.wasIncorrect || Boolean(previous && !isPendingGradingItem(previous) && ["incorrect", "partial"].includes(previous.verdict));
      const graded = { ...grading, submissionId: upload.id, wasIncorrect };
      results.set(assignmentQuestionId, graded);
      if (!firstHandedIn.has(assignmentQuestionId)) firstHandedIn.set(assignmentQuestionId, { at: Number(upload.submitted_at ?? upload.created_at), result: graded });
    }
  }
  const items = sheet.map((question) => ({ id: question.id, number: question.question_number, question: { ...parseJson<Question>(question.source_json, {} as Question), ...(question.code ? { code: question.code } : {}) }, result: results.get(question.id) ?? null }));
  const { groups } = parseJson<HomeworkSheet>(row.sheet_json, {});
  let from = 0;
  const days: HomeworkDay[] = (groups?.length ? groups : [{ title: "", size: items.length }]).map((group) => {
    const day = items.slice(from, from += group.size);
    const first = day.flatMap((item) => firstHandedIn.get(item.id) ?? []);
    const { correct, incorrect, pending } = tally(first.map((item) => item.result));
    return { title: group.title, size: group.size, ...tally(day.flatMap((item) => item.result ?? [])), firstAttempt: { correct, incorrect, pending }, handedInAt: first.length ? Math.min(...first.map((item) => item.at)) : null };
  });
  return {
    days, questions: items,
    uploads: handedIn.map((upload) => ({ id: upload.id, version: Number(upload.version), status: upload.status, pageCount: Number(upload.page_count), createdAt: Number(upload.created_at), submittedAt: upload.submitted_at == null ? null : Number(upload.submitted_at) })),
  };
}

// Only homework uploaded after it was completed is graded; legacy assignment templates stay out of every list and action.
const SUBMISSION_SELECT = `SELECT homework_submissions.*, homework_assignments.title AS assignment_title, homework_assignments.outputs_json, homework_assignments.curriculum,
  homework_assignments.sheet_json, homework_assignments.status AS assignment_status, homework_assignments.created_at AS assignment_created_at, homework_assignments.owner_user_id AS owner_user_id, students.name AS student_name
  FROM homework_submissions JOIN homework_assignments ON homework_assignments.id = homework_submissions.assignment_id
  JOIN students ON students.id = homework_submissions.student_id
  WHERE homework_assignments.input_mode = 'completed_homework'`;

async function teacherSubmissionRow(id: string, user: AuthUser) {
  const row = await appEnv().DB.prepare(`${SUBMISSION_SELECT} AND homework_submissions.id = ? AND homework_assignments.owner_user_id = ?`)
    .bind(id, user.id).first<Record<string, unknown>>();
  if (!row) throw responseError("提交记录不存在", 404); return row;
}

// 作业批改's list: each upload's status and the same result counts its page shows.
export async function readTeacherSubmissions(user: AuthUser): Promise<HomeworkSubmissionListItem[]> {
  const rows = await appEnv().DB.prepare(`${SUBMISSION_SELECT} AND homework_assignments.status <> 'archived' AND homework_assignments.owner_user_id = ? ORDER BY homework_submissions.updated_at DESC`)
    .bind(user.id).all<Record<string, unknown>>();
  const { readRecognizedQuestionNumbers } = await import("./homework-page-coverage");
  return Promise.all((rows.results as Array<Record<string, unknown>>).map(async (row) => {
    const [grading, recognized] = await Promise.all([gradingRows(String(row.id)), readRecognizedQuestionNumbers(String(row.id))]);
    return { id: String(row.id), assignmentId: String(row.assignment_id), assignmentTitle: String(row.assignment_title), studentName: String(row.student_name),
      status: row.status as SubmissionStatus, createdAt: Number(row.created_at), gradingSummary: gradingSummary(uploadGradingItems(grading.results, recognized, row)) };
  }));
}

export async function countGradingHomework(user: AuthUser) {
  const row = await appEnv().DB.prepare(`SELECT COUNT(DISTINCT assignment_id) AS count FROM (${SUBMISSION_SELECT}
    AND homework_assignments.status <> 'archived' AND homework_assignments.owner_user_id = ? AND homework_submissions.status IN ('submitted', 'processing'))`)
    .bind(user.id).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function readTeacherSubmission(id: string, user: AuthUser) { return submissionDetails(await teacherSubmissionRow(id, user)); }

export async function createCompletedSubmission(input: { studentId: string; title: string; outputs?: unknown; curriculum?: unknown }, user: AuthUser) {
  requireHomeworkEnabled(); await ownedStudent(input.studentId, user.id);
  const title = text(input.title,120); if (!title) throw responseError("请填写作业名称",400);
  const assignmentId=crypto.randomUUID(), id=crypto.randomUUID(), now=Date.now();
  await appEnv().DB.batch([
    appEnv().DB.prepare("INSERT INTO homework_assignments(id,owner_user_id,title,instructions,status,template_confirmed,created_at,updated_at,input_mode,outputs_json,curriculum) VALUES(?,?,?,'','draft',0,?,?,'completed_homework',?,?)").bind(assignmentId,user.id,title,now,now,JSON.stringify(normalizeHomeworkOutputs(input.outputs)),homeworkCurriculum(input.curriculum)),
    appEnv().DB.prepare("INSERT INTO homework_submissions(id,assignment_id,student_id,version,status,submitted_by_type,submitted_by_id,created_at,updated_at) VALUES(?,?,?,1,'draft','teacher',?,?,?)").bind(id,assignmentId,input.studentId,user.id,now,now),
  ]);
  return readTeacherSubmission(id,user);
}

const MAX_ASSIGNED_QUESTIONS = 300;
// An assigned homework feeds the wrong book and the student's knowledge profile; its own per-homework report stays off,
// since the 学情报告 covers a whole period.
const ASSIGNED_OUTPUTS = { wrongBook: true, report: false, profile: true };
// Fields that belong to a library record or an account, not to the question a student is given.
const RECORD_FIELDS = ["canEdit", "createdBy", "createdByEmail", "moduleId", "categoryId", "optimizedAt", "recognitionDurationMs", "diagramReconstructionDurationMs", "importFileName"] as const;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

function assignedGroups(value: unknown, count: number): HomeworkSheetGroup[] {
  const groups = (Array.isArray(value) ? value : []).map((group) => ({ title: text((group as { title?: unknown })?.title, 60), size: Math.floor(Number((group as { size?: unknown })?.size) || 0) }))
    .filter((group) => group.size > 0);
  if (!groups.length) return [];
  if (groups.length > 31 || groups.reduce((sum, group) => sum + group.size, 0) !== count) throw responseError("分组与题目数量不一致", 400);
  return groups.map((group, index) => ({ title: group.title || `第 ${index + 1} 天`, size: group.size }));
}

// The printed number of each question: 1, 2, 3… or, in days, D2-3 for 第 2 天 第 3 题 (each day numbers from 1).
function assignedNumbers(groups: HomeworkSheetGroup[], count: number) {
  if (!groups.length) return Array.from({ length: count }, (_, index) => String(index + 1));
  return groups.flatMap((group, day) => Array.from({ length: group.size }, (_, index) => `D${day + 1}-${index + 1}`));
}

// 菁优网 analyses say what a question tests (【点评】本题考查去括号的方法…); those words tag a question the library never saw.
function testedTopics(analysis: string) {
  return [...analysis.matchAll(/本题(?:主要)?考查(?:了)?([^。．；;\n]{2,60})/g)].map((match) => match[1]);
}

// A question has a reference when its answer says more than 见解析, or an analysis holds the working.
function hasReference(question: Pick<Question, "answer" | "analysis">) {
  const answer = String(question.answer ?? "").trim();
  return Boolean(answer && answer !== "见解析" || String(question.analysis ?? "").trim());
}

/**
 * 布置作业: a material from 快速排版 handed to one or more students. Each student gets a homework of their own whose
 * questions and answers are stored now, waiting for the work to come back. A library question is copied from the
 * library itself; any other question (one read from a Word, a wrong-book snapshot) as the browser sent it, its
 * pictures stored for this teacher only. Task groups have no preset submission dates.
 */
export async function createAssignedHomework(input: { studentIds?: unknown; title?: unknown; groups?: unknown; questions?: unknown; recordId?: unknown }, user: AuthUser) {
  requireHomeworkEnabled();
  const studentIds = [...new Set(Array.isArray(input.studentIds) ? input.studentIds.map((id) => String(id)) : [])];
  if (!studentIds.length || studentIds.length > 200) throw responseError("请选择 1–200 位要布置的学生", 400);
  const students = await Promise.all(studentIds.map((id) => ownedStudent(id, user.id)));
  const title = text(input.title, 120); if (!title) throw responseError("请填写作业名称", 400);
  const raw = Array.isArray(input.questions) ? input.questions.filter((item): item is Question => Boolean(item) && typeof item === "object") : [];
  if (!raw.length) throw responseError("这份资料里没有题目", 400);
  if (raw.length > MAX_ASSIGNED_QUESTIONS) throw responseError(`一份作业最多 ${MAX_ASSIGNED_QUESTIONS} 道题`, 400);
  const groups = assignedGroups(input.groups, raw.length);
  const numbers = assignedNumbers(groups, raw.length);
  // The record is remembered only when it is this teacher's; the archive then knows the plan is handed out.
  const record = typeof input.recordId === "string" && input.recordId ? await appEnv().DB.prepare("SELECT id FROM typeset_records WHERE id = ? AND owner_user_id = ?")
    .bind(input.recordId, user.id).first<{ id: string }>() : null;
  const sheet: HomeworkSheet = { groups, ...(record ? { recordId: record.id } : {}) };
  const { readLibrary, storeTeacherQuestionMedia } = await import("./library");
  const library = new Map((await readLibrary(user)).questions.map((question) => [question.id, question]));
  const { index: graph } = await (await import("./knowledge-graph")).loadPublishedKnowledgeGraph();
  const questions = [];
  for (const item of raw) {
    const fromLibrary = library.get(String(item.id ?? ""));
    const copy: Record<string, unknown> = { ...(fromLibrary ?? item) };
    for (const field of RECORD_FIELDS) delete copy[field];
    if (new TextEncoder().encode(JSON.stringify(copy)).byteLength > MAX_SOURCE_BYTES) throw responseError("有一道题的内容过大，无法布置", 413);
    const source = fromLibrary ? copy as Question : await storeTeacherQuestionMedia(copy as Question, user);
    const type = QUESTION_TYPES.includes(source.type) ? source.type : "解答题";
    const stem = text(source.stem, 100_000), answer = text(source.answer, 100_000), analysis = text(source.analysis, 100_000);
    const tags = Array.isArray(source.tags) ? source.tags.map((tag) => text(tag, 120)).filter(Boolean) : [];
    const taxonomyKeys = fromLibrary && Array.isArray(source.taxonomyKeys) && source.taxonomyKeys.length ? source.taxonomyKeys
      : resolveKnowledgeTaxonomyKeys([...tags, ...testedTopics(analysis)], stem, graph);
    questions.push({ source, type, stem, answer, analysis, tags, taxonomyKeys, options: Array.isArray(source.options) ? source.options.map((option) => text(option, 2_000)) : [],
      reference: hasReference({ answer, analysis }), fromLibrary: Boolean(fromLibrary) });
  }
  const db = appEnv().DB;
  const created: Array<{ id: string; studentId: string; studentName: string }> = [];
  for (const student of students) {
    const assignmentId = crypto.randomUUID(), submissionId = crypto.randomUUID(), now = Date.now();
    const statements = [
      db.prepare(`INSERT INTO homework_assignments(id,owner_user_id,title,instructions,status,template_confirmed,created_at,updated_at,input_mode,outputs_json,curriculum,sheet_json)
        VALUES(?,?,?,'','published',0,?,?,'completed_homework',?,'school',?)`).bind(assignmentId, user.id, title, now, now, JSON.stringify(ASSIGNED_OUTPUTS), JSON.stringify(sheet)),
      ...questions.map((question, index) => db.prepare(`INSERT INTO assignment_questions(id,assignment_id,question_number,page_number,type,stem,options_json,answer,analysis,bbox_json,confidence,warnings_json,
          knowledge_tags_json,taxonomy_keys_json,capability_keys_json,sort_order,created_at,updated_at,reference_source,reference_verified,reference_evidence,input_evidence_json,source_json)
        VALUES(?,?,?,0,?,?,?,?,?,NULL,1,'[]',?,?,'[]',?,?,?,?,?,?,'{}',?)`).bind(crypto.randomUUID(), assignmentId, numbers[index], question.type, question.stem,
          JSON.stringify(question.options), question.answer, question.analysis, JSON.stringify(question.tags), JSON.stringify(question.taxonomyKeys), index, now, now,
          question.reference ? "provided" : "unresolved", question.reference ? 1 : 0,
          question.reference ? question.fromLibrary ? "题库原题答案" : "布置时资料自带的答案" : "布置时没有答案，批改时由 AI 解题并核验", JSON.stringify(question.source))),
    ];
    for (let start = 0; start < statements.length; start += 50) await db.batch(statements.slice(start, start + 50));
    // The waiting upload is written last: until it exists, a half-written homework shows up nowhere.
    await db.prepare("INSERT INTO homework_submissions(id,assignment_id,student_id,version,status,submitted_by_type,submitted_by_id,created_at,updated_at) VALUES(?,?,?,1,'draft','teacher',?,?,?)")
      .bind(submissionId, assignmentId, student.id, user.id, now, now).run();
    created.push({ id: submissionId, studentId: student.id, studentName: student.name });
  }
  return created;
}

/**
 * The teacher's homework for the archive (one student's, or every student's), newest first, each with the student it
 * belongs to: an assigned homework counts its whole sheet (handed-in questions against all of them) day by day, an
 * uploaded one the questions its last upload found.
 */
async function teacherHomework(user: AuthUser, studentId?: string) {
  const rows = await appEnv().DB.prepare(`${SUBMISSION_SELECT} AND homework_assignments.status <> 'archived' AND homework_assignments.owner_user_id = ?${studentId ? " AND homework_submissions.student_id = ?" : ""}
    ORDER BY homework_assignments.created_at DESC, homework_submissions.version DESC`).bind(user.id, ...(studentId ? [studentId] : [])).all<Record<string, unknown>>();
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of rows.results as Array<Record<string, unknown>>) if (!latest.has(String(row.assignment_id))) latest.set(String(row.assignment_id), row);
  return Promise.all([...latest.values()].map(async (row): Promise<{ studentId: string; homework: StudentHomework }> => {
    const assigned = await assignedHomework(row, false);
    const results = assigned ? assigned.questions.flatMap((question) => question.result ?? [])
      : row.status === "published" ? await uploadResults(String(row.id)) : [];
    return { studentId: String(row.student_id), homework: {
      assignmentId: String(row.assignment_id), title: String(row.assignment_title), assigned: Boolean(assigned), createdAt: Number(row.assignment_created_at),
      total: assigned ? assigned.questions.length : results.length, ...tally(results),
      latest: { id: String(row.id), status: row.status as SubmissionStatus, version: Number(row.version), updatedAt: Number(row.updated_at) },
      days: assigned?.days ?? null, recordId: assigned ? parseJson<HomeworkSheet>(row.sheet_json, {}).recordId ?? null : null,
    } };
  }));
}

export async function readStudentHomework(studentId: string, user: AuthUser): Promise<StudentHomework[]> {
  await ownedStudent(studentId, user.id);
  return (await teacherHomework(user, studentId)).map((entry) => entry.homework);
}

/** The badges beside every student in 学生档案 in one read; students with neither 批改中 nor 作业中 are left out. */
export async function readHomeworkProgress(user: AuthUser) {
  const byStudent = new Map<string, StudentHomework[]>();
  for (const { studentId, homework } of await teacherHomework(user)) byStudent.set(studentId, [...byStudent.get(studentId) ?? [], homework]);
  return Object.fromEntries([...byStudent].flatMap(([studentId, homework]) => {
    const progress = homeworkProgress(homework);
    return progress ? [[studentId, progress]] : [];
  }));
}

/**
 * A new upload keeps the earlier ones and their results untouched. For an assigned homework it covers the whole sheet,
 * one day's questions not handed in yet, or one day's mistakes to correct. One upload is graded at a time: the latest
 * takes the new scope while it is still 待上传, or when its grading failed (the teacher agreed to give it up first).
 */
export async function createSubmissionVersion(submissionId: string, user: AuthUser, correctionDay?: unknown, uploadDay?: unknown) {
  const current = await teacherSubmissionRow(submissionId, user);
  const dayIndex = uploadDay ?? correctionDay;
  let questionIds: string[] = [];
  if (dayIndex !== undefined) {
    const assigned = await assignedHomework(current);
    if (!assigned || typeof dayIndex !== "number" || !Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= assigned.days.length) throw responseError("请选择这份作业中的一天", 400);
    const from = assigned.days.slice(0, dayIndex).reduce((sum, day) => sum + day.size, 0);
    const dayQuestions = assigned.questions.slice(from, from + assigned.days[dayIndex].size);
    questionIds = (uploadDay !== undefined ? dayQuestions.filter(({ result }) => !result)
      : dayQuestions.filter(({ result }) => result && !isPendingGradingItem(result) && ["incorrect", "partial"].includes(result.verdict))).map((question) => question.id);
    if (!questionIds.length) throw responseError(uploadDay !== undefined ? "这一天的题目都已交过" : "这一天没有需要订正的错题", 409);
  }
  const latest = await appEnv().DB.prepare("SELECT id, version, status, reprocess_question_ids_json, published_at FROM homework_submissions WHERE assignment_id = ? AND student_id = ? ORDER BY version DESC LIMIT 1")
    .bind(current.assignment_id, current.student_id).first<{ id: string; version: number; status: SubmissionStatus; reprocess_question_ids_json: string; published_at: number | null }>();
  // An upload published before keeps its results even when grading it again failed.
  if (latest?.status === "failed" && latest.published_at != null) throw responseError(`第 ${latest.version} 次上传重新批改失败，先打开它点“重新批改”，完成后再上传`, 409);
  if (latest && (latest.status === "draft" || latest.status === "failed")) {
    if (latest.status === "failed") await resetUpload(latest.id, user.id);
    if (latest.reprocess_question_ids_json !== JSON.stringify(questionIds)) await appEnv().DB.prepare("UPDATE homework_submissions SET reprocess_question_ids_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(questionIds), Date.now(), latest.id).run();
    return readTeacherSubmission(latest.id, user);
  }
  if (latest && latest.status !== "published") throw responseError(`第 ${latest.version} 次上传还在批改，完成或停止批改后再上传`, 409);
  const id = crypto.randomUUID(); const now = Date.now();
  await appEnv().DB.prepare(`INSERT INTO homework_submissions
    (id, assignment_id, student_id, version, status, submitted_by_type, submitted_by_id, reprocess_question_ids_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', 'teacher', ?, ?, ?, ?)`)
    .bind(id, current.assignment_id, current.student_id, Number(latest?.version ?? 0) + 1, user.id, JSON.stringify(questionIds), now, now).run();
  return readTeacherSubmission(id, user);
}

/**
 * Returns an upload whose grading is stopped or failed to 待上传: its results so far, its pages and its original PDFs
 * go, since they were the wrong files or are uploaded again. A run still in flight stops writing once it sees this.
 */
async function resetUpload(id: string, ownerUserId: string) {
  const db = appEnv().DB;
  const assets = await db.prepare(`SELECT id, r2_key FROM homework_assets WHERE owner_user_id = ? AND (id IN
      (SELECT original_asset_id FROM submission_pages WHERE submission_id = ? UNION SELECT processed_asset_id FROM submission_pages WHERE submission_id = ?)
      OR (upload_submission_id = ? AND role = 'submission_original' AND content_type = 'application/pdf'))`)
    .bind(ownerUserId, id, id, id).all<{ id: string; r2_key: string }>();
  await db.batch([
    db.prepare("UPDATE homework_submissions SET status = 'draft', submitted_at = NULL, grading_run_id = '', failure_reason = '', updated_at = ? WHERE id = ?").bind(Date.now(), id),
    db.prepare("DELETE FROM grading_items WHERE submission_id = ?").bind(id),
    db.prepare("DELETE FROM submission_pages WHERE submission_id = ?").bind(id),
  ]);
  await deleteHomeworkAssetRows(assets.results, ownerUserId);
}

/** 停止批改，重新上传: the upload goes back to 待上传 with the same scope (one day, or one day's mistakes). */
export async function cancelSubmissionGrading(id: string, user: AuthUser) {
  const row = await teacherSubmissionRow(id, user);
  if (!["submitted", "processing", "failed"].includes(String(row.status))) throw responseError("只有批改中或处理失败的上传可以重新上传", 409);
  if (row.published_at != null) throw responseError("这次上传已经出过结果，不能清空重传；重新批改完成后再上传新的", 409);
  await resetUpload(id, user.id);
  return readTeacherSubmission(id, user);
}

async function ownedPageAssets(submissionId: string, user: AuthUser, assetIds: string[]) {
  const unique = [...new Set(assetIds)];
  const rows = await appEnv().DB.prepare(`SELECT id FROM homework_assets WHERE owner_user_id = ? AND upload_submission_id = ? AND role = 'submission_original'
    AND content_type <> 'application/pdf' AND id IN (${unique.map(() => "?").join(",")})`).bind(user.id, submissionId, ...unique).all<{ id: string }>();
  if (rows.results.length !== unique.length) throw responseError("部分作业图片不存在或无权使用", 400);
}

export async function replaceSubmissionPages(id: string, pages: Array<{ assetId: string }>, user: AuthUser) {
  if (!pages.length || pages.length > 30) throw responseError("请上传 1 至 30 页作业", 400);
  const row = await teacherSubmissionRow(id, user);
  if (row.status !== "draft") throw responseError("当前提交已经锁定，不能修改页面", 409);
  const assetIds = pages.map((page) => String(page.assetId));
  await ownedPageAssets(id, user, assetIds);
  const previousAssets = await appEnv().DB.prepare(`SELECT homework_assets.id, homework_assets.r2_key FROM submission_pages
    JOIN homework_assets ON homework_assets.id = submission_pages.original_asset_id OR homework_assets.id = submission_pages.processed_asset_id
    WHERE submission_pages.submission_id = ?`).bind(id).all<{ id: string; r2_key: string }>();
  await appEnv().DB.prepare("DELETE FROM submission_pages WHERE submission_id = ?").bind(id).run();
  const now = Date.now();
  // Pages are graded as uploaded, so the original photo is also the page the model reads.
  for (const [index, assetId] of assetIds.entries()) await appEnv().DB.prepare(`INSERT INTO submission_pages
    (id, submission_id, original_asset_id, processed_asset_id, page_order, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), id, assetId, assetId, index, now).run();
  await appEnv().DB.prepare("UPDATE homework_submissions SET updated_at = ? WHERE id = ?").bind(now, id).run();
  const retained = new Set(assetIds);
  for (const asset of previousAssets.results) if (!retained.has(asset.id)) {
    await homeworkAssetsBucket().delete(asset.r2_key);
    await appEnv().DB.prepare("DELETE FROM homework_assets WHERE id = ?").bind(asset.id).run();
  }
  return readTeacherSubmission(id, user);
}

// Without a queue the run happens inline and nothing retries it, so any failure here is final.
async function dispatchSubmissionGrading(id: string) {
  try {
    if (appEnv().HOMEWORK_GRADING_QUEUE) await appEnv().HOMEWORK_GRADING_QUEUE!.send({kind:"grade_submission",submissionId:id});
    else await (await import("./homework-grading")).processHomeworkSubmission(id);
  } catch (error) { await markDispatchFailure(id, error); throw error; }
}

async function markDispatchFailure(id: string, error: unknown) {
  await appEnv().DB.prepare("UPDATE homework_submissions SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'submitted' AND grading_run_id = ''")
    .bind(error instanceof Error ? error.message.slice(0, 500) : "批改任务提交失败", Date.now(), id).run();
}

export async function submitHomeworkSubmission(id: string, user: AuthUser) {
  const row = await teacherSubmissionRow(id, user);
  if (row.status !== "draft") throw responseError("当前提交不能再次提交", 409);
  const pageCount = await appEnv().DB.prepare("SELECT COUNT(*) AS count FROM submission_pages WHERE submission_id = ?").bind(id).first<{ count: number }>();
  if (!Number(pageCount?.count ?? 0)) throw responseError("请先上传作业页面", 400);
  const now = Date.now();
  const submitted = await appEnv().DB.batch([
    appEnv().DB.prepare("UPDATE homework_assignments SET status='closed',template_confirmed=0 WHERE id=? AND status <> 'archived'").bind(row.assignment_id),
    appEnv().DB.prepare(`UPDATE homework_submissions SET status = 'submitted', submitted_at = ?, grading_run_id = '', failure_reason = '', updated_at = ? WHERE id = ? AND status = 'draft'
      AND EXISTS (SELECT 1 FROM homework_assignments WHERE id = homework_submissions.assignment_id AND status <> 'archived')`).bind(now, now, id),
  ]);
  if (!submitted[1].meta.changes) throw responseError("这份作业已取消或当前提交已经锁定", 409);
  await dispatchSubmissionGrading(id);
  return readTeacherSubmission(id, user);
}

export async function retryHomeworkSubmission(id: string, user: AuthUser) {
  const row = await teacherSubmissionRow(id, user);
  if (row.status !== "failed") throw responseError("只有处理失败的提交可以重试", 409);
  const claimed = await appEnv().DB.prepare("UPDATE homework_submissions SET status = 'submitted', grading_run_id = '', failure_reason = '', updated_at = ? WHERE id = ? AND status = 'failed' AND grading_run_id = ''")
    .bind(Date.now(), id).run();
  if (!claimed.meta.changes) throw responseError("这份作业已开始重试或状态已变化", 409);
  await dispatchSubmissionGrading(id);
  return readTeacherSubmission(id, user);
}

export async function reviewSubmission(id: string, items: Array<Partial<GradingItem> & { id: string }>, user: AuthUser) {
  const row = await teacherSubmissionRow(id, user);
  if (!["review_required", "ready"].includes(String(row.status))) throw responseError("当前提交不在复核阶段", 409);
  const now = Date.now();
  for (const patch of items) {
    if (!VERDICTS.includes(patch.verdict as GradingVerdict)) throw responseError("批改结论无效", 400);
    const resolved = ["correct", "partial", "incorrect", "unreadable"].includes(String(patch.verdict));
    await appEnv().DB.prepare(`UPDATE grading_items SET verdict = ?, student_answer = ?, feedback = ?, error_type = ?, confidence = ?,
      requires_review = ?, reviewed_by = ?, reviewed_at = ?, bbox_json = json_remove(bbox_json, '$.errors'), updated_at = ? WHERE id = ? AND submission_id = ?`)
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
  const binary = Boolean(row.sheet_json) && homeworkCurriculum(row.curriculum) === "school";
  if (row.status !== "published") throw responseError("只有已发布结果可以修正", 409);
  if (!items.length || items.length > 200) throw responseError("请选择需要修正的题目", 400);
  const now = Date.now();
  for (const patch of items) {
    if (!(["correct", "partial", "incorrect", "unreadable", "review_required"] as GradingVerdict[]).includes(patch.verdict as GradingVerdict)) throw responseError("批改结论无效", 400);
    if (binary && !["correct", "incorrect"].includes(String(patch.verdict))) throw responseError("这份作业只判正确或错误", 400);
    const existing = await appEnv().DB.prepare(`SELECT g.*,q.answer AS standard_answer,q.analysis AS standard_analysis,q.reference_verified,q.stem,q.input_evidence_json FROM grading_items g JOIN assignment_questions q ON q.id=g.assignment_question_id WHERE g.id = ? AND g.submission_id = ?`).bind(patch.id, id).first<Record<string, unknown>>();
    if (!existing) throw responseError("批改项不存在", 404);
    if (patch.standardAnswer?.trim() && (patch.standardAnswer !== existing.standard_answer || patch.standardAnalysis !== existing.standard_analysis || (patch.referenceVerified === true && !Number(existing.reference_verified)))) await appEnv().DB.prepare("UPDATE assignment_questions SET answer=?,analysis=?,reference_source='provided',reference_verified=1,reference_evidence='教师补充并确认参考解答' WHERE id=? AND assignment_id=?")
      .bind(text(patch.standardAnswer,100_000),text(patch.standardAnalysis,100_000),existing.assignment_question_id,row.assignment_id).run();
    if(patch.stem?.trim() && patch.stem !== existing.stem) await appEnv().DB.prepare("UPDATE assignment_questions SET stem=? WHERE id=? AND assignment_id=?").bind(text(patch.stem,100_000),existing.assignment_question_id,row.assignment_id).run();
    // The teacher may supply the marks a paper prints but recognition missed; they belong to the question, not this attempt.
    const evidenceMax = normalizeMaxScore(parseJson<{ max_score?: unknown }>(existing.input_evidence_json, {}).max_score);
    const maxScore = binary ? null : patch.maxScore === undefined ? evidenceMax : normalizeMaxScore(patch.maxScore);
    if (maxScore !== evidenceMax) await appEnv().DB.prepare("UPDATE assignment_questions SET input_evidence_json=json_set(input_evidence_json,'$.max_score',?) WHERE id=? AND assignment_id=?")
      .bind(maxScore, existing.assignment_question_id, row.assignment_id).run();
    const marked = reconcileHomeworkScore(patch.verdict as GradingVerdict, patch.score !== undefined ? patch.score : patch.verdict === existing.verdict ? existing.score : null, maxScore, homeworkCurriculum(row.curriculum));
    const reference = await appEnv().DB.prepare("SELECT reference_verified FROM assignment_questions WHERE id=?").bind(existing.assignment_question_id).first<{reference_verified:number}>();
    // A question the teacher had already marked needs no reference answer: the verdict was always the teacher's own.
    if (["correct","partial","incorrect"].includes(String(patch.verdict)) && !reference?.reference_verified && !teacherMark(existing.input_evidence_json)) throw responseError("请先补充并确认本题参考答案",400);
    const next = { verdict: marked.verdict, score: marked.score, studentAnswer: text(patch.studentAnswer ?? existing.student_answer, 100_000),
      feedback: text(patch.feedback ?? existing.feedback, 4_000), errorType: text(patch.errorType ?? existing.error_type, 120),
      stepAnalysis: patch.stepAnalysis ?? parseJson<string[]>(existing.step_analysis_json, []), evidenceSummary: text(patch.evidenceSummary ?? existing.evidence_summary, 1_000),
      capabilityKeys: patch.capabilityKeys ?? parseJson<string[]>(existing.capability_keys_json, []), confidence: Math.max(0, Math.min(1, Number(patch.confidence ?? existing.confidence) || 0)) };
    await appEnv().DB.batch([
      appEnv().DB.prepare(`INSERT INTO grading_item_revisions (id, grading_item_id, submission_id, corrected_by, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), patch.id, id, user.id, JSON.stringify(existing), JSON.stringify(next), now),
      appEnv().DB.prepare(`UPDATE grading_items SET verdict = ?, score = ?, student_answer = ?, feedback = ?, error_type = ?, step_analysis_json = ?,
        evidence_summary = ?, capability_keys_json = ?, confidence = ?, requires_review = ?, reviewed_by = ?, reviewed_at = ?, corrected_at = ?,
        wrong_book_applied_at = NULL, bbox_json = json_remove(bbox_json, '$.errors'), updated_at = ? WHERE id = ? AND submission_id = ?`)
        .bind(next.verdict, next.score, next.studentAnswer, next.feedback, next.errorType, JSON.stringify(next.stepAnalysis), next.evidenceSummary,
          JSON.stringify(next.capabilityKeys), next.confidence, ["unreadable","review_required"].includes(String(next.verdict)) ? 1 : 0, user.id, now, now, now, patch.id, id),
    ]);

  }
  await (await import("./homework-outputs")).applySubmissionOutputs(await readTeacherSubmission(id, user), user, { refreshReport: true });
  return readTeacherSubmission(id, user);
}


export async function publishSubmission(id: string, user: AuthUser) {
  const row = await teacherSubmissionRow(id, user);
  try { await (await import("./homework-page-coverage")).assertCompletePageCoverage(id); } catch(error) { throw responseError(error instanceof Error?error.message:"页面尚未全部核验",409); }
  const { applySubmissionOutputs } = await import("./homework-outputs");
  if (!["ready", "published"].includes(String(row.status))) throw responseError("仍有题目需要复核，暂不能发布", 409);
  let submission = await submissionDetails(row);
  if (!submission.gradingItems.length) throw responseError("没有可发布的批改结果", 409);
  // Also fill historical gaps when publishing; complete explanations never trigger another model call.
  if (await (await import("./completed-homework-grading")).locateHomeworkErrors(submission)) submission = await submissionDetails(row);
  if (row.status === "published") { await applySubmissionOutputs(submission, user); return readTeacherSubmission(id, user); }
  // Reaching ready again means pending items were re-graded, so an earlier report is out of date.
  await applySubmissionOutputs(submission, user, { refreshReport: true });
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

export async function reprocessPendingSubmission(id:string, replacements:Array<{replacePageId?:string;assetId:string}>,user:AuthUser) {
  const row=await teacherSubmissionRow(id,user);
  if(row.status!=="published") throw responseError("请等待本次批改完成后再补充",409);
  if(row.sheet_json && homeworkCurriculum(row.curriculum)==="school")throw responseError("这份作业只判正确或错误，请上传错题订正",409);
  const pending=await appEnv().DB.prepare(`SELECT g.assignment_question_id FROM grading_items g JOIN assignment_questions q ON q.id=g.assignment_question_id
    WHERE g.submission_id=? AND (g.requires_review=1 OR g.verdict IN ('unreadable','review_required') OR (g.verdict IN ('incorrect','partial') AND (q.answer='' OR q.reference_verified=0)))`).bind(id).all<{assignment_question_id:string}>();
  const coverage=await (await import("./homework-page-coverage")).readPageCoverage(id);
  const pendingPages=coverage.pages.filter(p=>p.kind==='unreadable').map(p=>`page:${p.pageNumber}`);
  if(!pending.results.length && !pendingPages.length)throw responseError("没有待处理的题目",409);
  if(replacements.length)await ownedPageAssets(id,user,replacements.map(replacement=>String(replacement.assetId)));
  const changes:D1PreparedStatement[]=[]; const now=Date.now();
  for(const replacement of replacements){
    const page=await appEnv().DB.prepare('SELECT * FROM submission_pages WHERE id=? AND submission_id=?').bind(replacement.replacePageId,id).first<Record<string,unknown>>();
    if(!page)throw responseError("补图对应的原页面不存在",400);
    changes.push(appEnv().DB.prepare('INSERT INTO submission_page_revisions(id,submission_id,page_id,original_asset_id,processed_asset_id,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),id,page.id,page.original_asset_id,page.processed_asset_id,now));
    changes.push(appEnv().DB.prepare("UPDATE submission_pages SET original_asset_id=?,processed_asset_id=?,quality_json='{}' WHERE id=? AND submission_id=?").bind(replacement.assetId,replacement.assetId,page.id,id));
    changes.push(appEnv().DB.prepare("UPDATE grading_items SET bbox_json=json_remove(bbox_json,'$.errors') WHERE page_id=? AND submission_id=?").bind(page.id,id));
  }
  // Reuse pending-item recovery for historical mistakes whose reference answer was never generated or verified.
  changes.push(appEnv().DB.prepare(`UPDATE assignment_questions SET reference_fingerprint='' WHERE id IN
    (SELECT assignment_question_id FROM grading_items WHERE submission_id=? AND verdict IN ('incorrect','partial'))
    AND (answer='' OR reference_verified=0) AND reference_fingerprint NOT LIKE 'pending:%' AND reference_evidence NOT LIKE '教师补充并确认%'`).bind(id));
  changes.push(appEnv().DB.prepare("UPDATE homework_submissions SET status='submitted',submitted_at=?,grading_run_id='',reprocess_question_ids_json=?,updated_at=? WHERE id=?").bind(now,JSON.stringify([...pending.results.map(p=>p.assignment_question_id),...pendingPages]),now,id));
  changes.push(appEnv().DB.prepare('UPDATE homework_assignments SET template_confirmed=0 WHERE id=?').bind(row.assignment_id));
  await appEnv().DB.batch(changes);
  await dispatchSubmissionGrading(id);
  return readTeacherSubmission(id,user);
}

export async function rebuildSubmissionCoverage(id:string,user:AuthUser){
  const row=await teacherSubmissionRow(id,user);
  if(!["published","ready","failed"].includes(String(row.status)))throw responseError("请等待当前批改完成",409);
  const now=Date.now();
  const claimed=await appEnv().DB.prepare("UPDATE homework_submissions SET status='submitted',submitted_at=?,grading_run_id='',reprocess_question_ids_json='[]',failure_reason='',updated_at=? WHERE id=? AND status IN ('published','ready','failed')").bind(now,now,id).run();
  if(!claimed.meta.changes)return readTeacherSubmission(id,user);
  const previous=await appEnv().DB.prepare('SELECT * FROM grading_items WHERE submission_id=?').bind(id).all<Record<string,unknown>>();
  for(const item of previous.results)await appEnv().DB.prepare('INSERT INTO grading_item_revisions(id,grading_item_id,submission_id,corrected_by,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(),item.id,id,user.id,JSON.stringify(item),JSON.stringify({action:"rebuild-coverage",reason:"补全未处理页面，保留修复前记录"}),now).run();
  await appEnv().DB.prepare('UPDATE homework_assignments SET template_confirmed=0 WHERE id=?').bind(row.assignment_id).run();
  await dispatchSubmissionGrading(id);
  return readTeacherSubmission(id,user);
}

export async function updateSubmission(id: string, body: { action?: string; pages?: Array<{ assetId: string; replacePageId?: string }>; items?: Array<Partial<GradingItem> & { id: string }>; profile?: boolean; correctionDay?: unknown; uploadDay?: unknown }, user: AuthUser) {
  const row = await teacherSubmissionRow(id, user);
  if (row.assignment_status === "archived") throw responseError("这份作业已取消，不能继续上传或批改", 409);
  if (body.action === "cancel-homework") {
    if (!row.sheet_json) throw responseError("只有布置给学生的作业可以取消", 400);
    // Archive the whole homework, including a multi-day sheet, without deleting its earlier results or evidence.
    const archived = await appEnv().DB.prepare(`UPDATE homework_assignments SET status = 'archived', updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status <> 'archived' AND NOT EXISTS
        (SELECT 1 FROM homework_submissions WHERE assignment_id = homework_assignments.id AND status IN ('submitted', 'processing', 'ready', 'review_required'))`)
      .bind(Date.now(), row.assignment_id, user.id).run();
    if (!archived.meta.changes) throw responseError("这份作业正在批改，请先停止批改再取消作业", 409);
    return submissionDetails(row);
  }
  if (body.action === "profile") {
    if (typeof body.profile !== "boolean") throw responseError("计入定档必须为开或关", 400);
    if (await assignedHomework(row)) throw responseError("布置的作业总是计入定档", 400);
    const db = appEnv().DB;
    const active = db.prepare("SELECT id FROM homework_submissions WHERE assignment_id=? AND status IN ('submitted','processing','ready') LIMIT 1").bind(row.assignment_id);
    if (await active.first()) throw responseError("这份作业正在批改或发布，请完成后再调整定档", 409);
    const statements = [db.prepare("UPDATE homework_assignments SET outputs_json=json_set(outputs_json,'$.profile',json(?)),updated_at=? WHERE id=? AND owner_user_id=?")
      .bind(body.profile ? "true" : "false", Date.now(), row.assignment_id, user.id)];
    if (body.profile) {
      const published = await db.prepare("SELECT id,submitted_at,created_at FROM homework_submissions WHERE assignment_id=? AND status='published' ORDER BY version")
        .bind(row.assignment_id).all<{ id: string; submitted_at: number | null; created_at: number }>();
      const { replaceSubmissionCapabilityEvidence } = await import("./homework-capabilities");
      for (const upload of published.results) {
        const submission = await readTeacherSubmission(upload.id, user);
        await replaceSubmissionCapabilityEvidence({ ownerUserId: user.id, studentId: submission.studentId, assignmentId: submission.assignmentId,
          submissionId: submission.id, gradingItems: submission.gradingItems, at: Number(upload.submitted_at ?? upload.created_at) }, statements);
      }
    } else statements.push(db.prepare("DELETE FROM student_capability_evidence WHERE assignment_id=? AND owner_user_id=?").bind(row.assignment_id, user.id));
    if (await active.first()) throw responseError("这份作业正在批改或发布，请完成后再调整定档", 409);
    await db.batch(statements);
    return readTeacherSubmission(id, user);
  }
  if (body.action === "save-pages") return replaceSubmissionPages(id, body.pages ?? [], user);
  if (body.action === "orient-pages") {
    await teacherSubmissionRow(id, user);
    await (await import("./homework-assets")).orientHomeworkPages(id);
    return readTeacherSubmission(id, user);
  }
  if (body.action === "submit") return submitHomeworkSubmission(id, user);
  if (body.action === "retry") return retryHomeworkSubmission(id, user);
  if (body.action === "new-version") return createSubmissionVersion(id, user, body.correctionDay, body.uploadDay);
  if (body.action === "cancel") return cancelSubmissionGrading(id, user);
  if (body.action === "rebuild-coverage") return rebuildSubmissionCoverage(id, user);
  if (body.action === "attach-figures") { await (await import("./homework-figures")).attachMissingFigures(id, user); return readTeacherSubmission(id, user); }
  if (body.action === "reprocess-pending") return reprocessPendingSubmission(id, body.pages ?? [], user);
  if (body.action === "review") return reviewSubmission(id, body.items ?? [], user);
  if (body.action === "correct") return correctPublishedSubmission(id, body.items ?? [], user);
  if (body.action === "publish") return publishSubmission(id, user);
  throw responseError("未知的提交操作", 400);
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

export function homeworkDb() { return appEnv().DB; }
