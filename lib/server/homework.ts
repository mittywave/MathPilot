import { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AssignedHomework, AssignmentQuestion, AuthUser, GradingItem, GradingVerdict, HomeworkCurriculum, HomeworkDay, HomeworkSheetGroup, HomeworkSubmission, HomeworkSubmissionListItem, Question, QuestionType,
  StudentHomework, SubmissionPage, SubmissionStatus,
} from "../types";
import { requireHomeworkEnabled, scheduleHomeworkAssetCleanup } from "./homework-assets";
import { normalizeHomeworkOutputs } from "./homework-outputs";
import { isPendingGradingItem, normalizeMaxScore, reconcileHomeworkScore, summarizeHomeworkScore } from "../homework-grading-rules.mjs";
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
export function withHomeworkGradingRun<T>(id: string, token: string, signal: AbortSignal, work: () => Promise<T>, updatedAt?: number) {
  const database = (env as unknown as AppEnv).DB;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const batch = async (statements: D1PreparedStatement[]) => {
    signal.throwIfAborted();
    if (!statements.length) return [];
    const guard = database.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM homework_submissions s JOIN homework_assignments a ON a.id = s.assignment_id
      WHERE s.id = ? AND s.grading_run_id = ? AND s.status IN ('processing','ready','published') AND a.status <> 'archived'
        AND (? IS NULL OR s.updated_at = ?)
    ) THEN 1 ELSE json_extract('grading run no longer owns submission', '$') END AS valid`).bind(id, token, updatedAt ?? null, updatedAt ?? null);
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
    stem: String(row.stem), figures: questionFigures(row.question_evidence_json), teacherMark: teacherMark(row.question_evidence_json), standardAnswer: String(row.standard_answer ?? ""), standardAnalysis: String(row.standard_analysis ?? ""),
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
function gradingRows(submissionIds: string | string[], summary = false): Promise<{ results: Record<string, unknown>[] }> {
  return appEnv().DB.prepare(`SELECT ${summary ? `grading_items.id,grading_items.submission_id,grading_items.assignment_question_id,grading_items.verdict,
      grading_items.requires_review,grading_items.score,grading_items.wrong_book_applied_at,
      json_object('teacher_mark',json_extract(assignment_questions.input_evidence_json,'$.teacher_mark'),'max_score',json_extract(assignment_questions.input_evidence_json,'$.max_score')) AS question_evidence_json,
      CASE WHEN trim(assignment_questions.answer)<>'' THEN 'present' ELSE '' END AS standard_answer,
      CASE WHEN trim(assignment_questions.analysis)<>'' THEN 'present' ELSE '' END AS standard_analysis` : `grading_items.*,assignment_questions.stem,
      assignment_questions.input_evidence_json AS question_evidence_json,assignment_questions.answer AS standard_answer,assignment_questions.analysis AS standard_analysis`},
      assignment_questions.question_number,assignment_questions.type AS question_type,assignment_questions.reference_source,assignment_questions.reference_verified,assignment_questions.reference_evidence
    FROM grading_items JOIN assignment_questions ON assignment_questions.id=grading_items.assignment_question_id
    WHERE grading_items.submission_id IN (SELECT value FROM json_each(?)) ORDER BY assignment_questions.sort_order`)
    .bind(JSON.stringify(typeof submissionIds === "string" ? [submissionIds] : submissionIds)).all<Record<string, unknown>>();
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

type UploadRow = { id: string; assignment_id: string; student_id: string; version: number; status: SubmissionStatus; created_at: number; submitted_at: number | null; page_count: number };
type ResultRow = { submission_id: string; assignment_question_id: string; question_number: string; verdict: GradingVerdict; requires_review: number; standard_answer: string; standard_analysis: string; reference_verified: number; question_evidence_json: string };

// The published results of one upload, without questions a later reading of its pages no longer finds.
async function uploadResults(submissionIds: string[], bodies = false) {
  const [rows, recognized] = await Promise.all([
    appEnv().DB.prepare(`SELECT g.submission_id,g.assignment_question_id,q.question_number,g.verdict,g.requires_review,
        ${bodies ? "q.answer" : "CASE WHEN trim(q.answer)<>'' THEN 'present' ELSE '' END"} AS standard_answer,
        ${bodies ? "q.analysis" : "CASE WHEN trim(q.analysis)<>'' THEN 'present' ELSE '' END"} AS standard_analysis,q.reference_verified,
        json_object('teacher_mark',json_extract(q.input_evidence_json,'$.teacher_mark')) AS question_evidence_json FROM grading_items g
      JOIN assignment_questions q ON q.id=g.assignment_question_id WHERE g.submission_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(submissionIds)).all<ResultRow>(),
    import("./homework-page-coverage").then(({ readRecognizedQuestionNumbers }) => readRecognizedQuestionNumbers(submissionIds)),
  ]);
  const grouped = new Map<string, ResultRow[]>();
  for (const row of rows.results) { const group = grouped.get(row.submission_id) ?? []; group.push(row); grouped.set(row.submission_id, group); }
  return new Map(submissionIds.map(id => {
    const numbers = recognized.get(id);
    const results = (grouped.get(id) ?? [])
      .filter(row => !numbers || numbers.has(row.question_number) || [...numbers].some(number => row.question_number.startsWith(`${number}(`)))
      .map(row => ({ assignmentQuestionId: row.assignment_question_id,
        verdict: VERDICTS.includes(row.verdict) ? row.verdict : "review_required" as GradingVerdict,
        requiresReview: Number(row.requires_review) === 1, teacherMark: teacherMark(row.question_evidence_json),
        standardAnswer: String(row.standard_answer ?? ""), standardAnalysis: String(row.standard_analysis ?? ""), referenceVerified: Number(row.reference_verified) === 1 }));
    return [id, results] as const;
  }));
}

// Task groups and the 快速排版 record they were assigned from. Legacy start dates are ignored.
type HomeworkSheet = { groups?: HomeworkSheetGroup[]; recordId?: string; requestHash?: string };

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
function assignedHomework(row: Record<string, unknown>, bodies?: boolean): Promise<AssignedHomework | null>;
function assignedHomework(rows: Record<string, unknown>[], bodies?: boolean): Promise<Map<string, AssignedHomework>>;
async function assignedHomework(input: Record<string, unknown> | Record<string, unknown>[], bodies = true) {
  const rows = (Array.isArray(input) ? input : [input]).filter(row => row.sheet_json);
  const result = new Map<string, AssignedHomework>();
  if (!rows.length) return Array.isArray(input) ? result : null;
  const ids = JSON.stringify([...new Set(rows.map(row => String(row.assignment_id)))]);
  const [questions, uploads] = await Promise.all([
    appEnv().DB.prepare(`SELECT assignment_id,id,question_number${bodies ? ",source_json,(SELECT printf('%04d',number) FROM question_codes WHERE question_id=NULLIF(question_key,'')) AS code" : ""}
      FROM assignment_questions WHERE assignment_id IN (SELECT value FROM json_each(?)) AND source_json<>'' ORDER BY sort_order`)
      .bind(ids).all<{ assignment_id: string; id: string; question_number: string; source_json?: string; code?: string | null }>(),
    appEnv().DB.prepare(`SELECT assignment_id,student_id,id,version,status,created_at,submitted_at${bodies ? ",(SELECT COUNT(*) FROM submission_pages p WHERE p.submission_id=s.id) AS page_count" : ""}
      FROM homework_submissions s WHERE assignment_id IN (SELECT value FROM json_each(?)) ORDER BY version`).bind(ids).all<UploadRow>(),
  ]);
  const questionRows = questions.results as Array<{ assignment_id: string; id: string; question_number: string; source_json?: string; code?: string | null }>;
  const uploadRows = uploads.results as UploadRow[];
  const grades = await uploadResults(uploadRows.filter(upload => upload.status === "published").map(upload => upload.id), bodies);
  const byAssignment = new Map<string, typeof questionRows>(), byStudent = new Map<string, UploadRow[]>();
  for (const question of questionRows) { const group = byAssignment.get(question.assignment_id) ?? []; group.push(question); byAssignment.set(question.assignment_id, group); }
  for (const upload of uploadRows) { const key = `${upload.assignment_id}:${upload.student_id}`, group = byStudent.get(key) ?? []; group.push(upload); byStudent.set(key, group); }
  for (const row of rows) {
    const sheet = byAssignment.get(String(row.assignment_id)) ?? [], handedIn = byStudent.get(`${row.assignment_id}:${row.student_id}`) ?? [];
    const results = new Map<string, NonNullable<AssignedHomework["questions"][number]["result"]>>();
    const firstHandedIn = new Map<string, { at: number; result: NonNullable<AssignedHomework["questions"][number]["result"]> }>();
    for (const upload of handedIn.filter(item => item.status === "published")) for (const result of grades.get(upload.id) ?? []) {
      const { assignmentQuestionId, ...original } = result;
      const grading = homeworkCurriculum(row.curriculum) === "school" && ["partial", "unreadable", "review_required"].includes(original.verdict)
        ? { ...original, verdict: "incorrect" as const, requiresReview: false } : original;
      const previous = results.get(assignmentQuestionId);
      const wasIncorrect = previous?.wasIncorrect || Boolean(previous && !isPendingGradingItem(previous) && ["incorrect", "partial"].includes(previous.verdict));
      const graded = { ...grading, submissionId: upload.id, wasIncorrect };
      results.set(assignmentQuestionId, graded);
      if (!firstHandedIn.has(assignmentQuestionId)) firstHandedIn.set(assignmentQuestionId, { at: Number(upload.submitted_at ?? upload.created_at), result: graded });
    }
    const items = sheet.map(question => ({ id: question.id, number: question.question_number, question: { ...parseJson<Question>(question.source_json, {} as Question), ...(question.code ? { code: question.code } : {}) }, result: results.get(question.id) ?? null }));
    const { groups } = parseJson<HomeworkSheet>(row.sheet_json, {});
    let from = 0;
    const days: HomeworkDay[] = (groups?.length ? groups : [{ title: "", size: items.length }]).map(group => {
      const day = items.slice(from, from += group.size), first = day.flatMap(item => firstHandedIn.get(item.id) ?? []);
      const { correct, incorrect, pending } = tally(first.map(item => item.result));
      return { title: group.title, size: group.size, ...tally(day.flatMap(item => item.result ?? [])), firstAttempt: { correct, incorrect, pending }, handedInAt: first.length ? Math.min(...first.map(item => item.at)) : null };
    });
    result.set(String(row.id), { days, questions: items,
      uploads: handedIn.map(upload => ({ id: upload.id, version: Number(upload.version), status: upload.status, pageCount: Number(upload.page_count ?? 0), createdAt: Number(upload.created_at), submittedAt: upload.submitted_at == null ? null : Number(upload.submitted_at) })),
    });
  }
  return Array.isArray(input) ? result : result.get(String(input.id)) ?? null;
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
export async function readTeacherSubmissions(user: AuthUser, cursor: string | null = null): Promise<{ submissions: HomeworkSubmissionListItem[]; nextCursor: string | null }> {
  const split = cursor?.indexOf(":") ?? -1, time = cursor ? Number(cursor.slice(0, split)) : 0, lastId = cursor?.slice(split + 1) ?? "";
  if (cursor && (split < 1 || !Number.isSafeInteger(time) || time < 0 || !lastId || lastId.length > 200)) throw responseError("分页位置无效", 400);
  const rows = await appEnv().DB.prepare(`${SUBMISSION_SELECT} AND homework_assignments.status<>'archived' AND homework_assignments.owner_user_id=?
    ${cursor ? "AND (homework_submissions.updated_at<? OR (homework_submissions.updated_at=? AND homework_submissions.id<?))" : ""}
    ORDER BY homework_submissions.updated_at DESC,homework_submissions.id DESC LIMIT 41`)
    .bind(user.id, ...(cursor ? [time, time, lastId] : [])).all<Record<string, unknown>>();
  const page = (rows.results as Record<string, unknown>[]).slice(0, 40), ids = page.map(row => String(row.id));
  const [grading, recognized] = await Promise.all([gradingRows(ids, true), import("./homework-page-coverage").then(({ readRecognizedQuestionNumbers }) => readRecognizedQuestionNumbers(ids))]);
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const item of grading.results) { const key = String(item.submission_id), group = grouped.get(key) ?? []; group.push(item); grouped.set(key, group); }
  const submissions = page.map(row => ({ id: String(row.id), assignmentId: String(row.assignment_id), assignmentTitle: String(row.assignment_title), studentName: String(row.student_name),
    status: row.status as SubmissionStatus, createdAt: Number(row.created_at), gradingSummary: gradingSummary(uploadGradingItems(grouped.get(String(row.id)) ?? [], recognized.get(String(row.id)) ?? null, row)) }));
  const last = page.at(-1);
  return { submissions, nextCursor: rows.results.length > 40 && last ? `${last.updated_at}:${last.id}` : null };
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
/** The question as a student is given it: the record's content, without those fields. */
export function givenQuestion(question: Question) {
  const copy: Record<string, unknown> = { ...question };
  for (const field of RECORD_FIELDS) delete copy[field];
  return copy as Question;
}

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
export function hasReference(question: Pick<Question, "answer" | "analysis">) {
  const answer = String(question.answer ?? "").trim();
  return Boolean(answer && answer !== "见解析" || String(question.analysis ?? "").trim());
}

/**
 * 布置作业: a material from 快速排版 handed to one or more students. Each student gets a homework of their own whose
 * questions and answers are stored now, waiting for the work to come back. A library question is copied from the
 * library itself; any new Word or wrong-book question is registered first with its permanent ID and media.
 * Task groups have no preset submission dates.
 */
export async function createAssignedHomework(input: { studentIds?: unknown; title?: unknown; groups?: unknown; questions?: unknown; recordId?: unknown; operationId?: unknown }, user: AuthUser) {
  requireHomeworkEnabled();
  const studentIds = [...new Set(Array.isArray(input.studentIds) ? input.studentIds.map((id) => String(id)) : [])];
  if (!studentIds.length || studentIds.length > 200) throw responseError("请选择 1–200 位要布置的学生", 400);
  const db = appEnv().DB;
  const owned = await db.prepare("SELECT id,name FROM students WHERE owner_user_id=? AND id IN (SELECT value FROM json_each(?))")
    .bind(user.id, JSON.stringify(studentIds)).all<{ id: string; name: string }>();
  if (owned.results.length !== studentIds.length) throw responseError("学生档案不存在", 404);
  const ownedStudents = owned.results as Array<{ id: string; name: string }>;
  const students = studentIds.map(id => ownedStudents.find(student => student.id === id)!);
  const title = text(input.title, 120); if (!title) throw responseError("请填写作业名称", 400);
  const raw = Array.isArray(input.questions) ? input.questions.filter((item): item is Question => Boolean(item) && typeof item === "object") : [];
  if (!raw.length) throw responseError("这份资料里没有题目", 400);
  if (raw.length > MAX_ASSIGNED_QUESTIONS) throw responseError(`一份作业最多 ${MAX_ASSIGNED_QUESTIONS} 道题`, 400);
  const groups = assignedGroups(input.groups, raw.length);
  const numbers = assignedNumbers(groups, raw.length);
  const operationId = input.operationId === undefined ? crypto.randomUUID() : String(input.operationId);
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(operationId)) throw responseError("布置操作标识无效", 400);
  const { readLibrary, ensureLibraryQuestions, hashText } = await import("./library");
  // Existing primary keys identify each operation/student pair; sheet metadata rejects changed-payload replays.
  const requestHash = await hashText(JSON.stringify({ studentIds: [...studentIds].sort(), title, groups, questions: raw, recordId: input.recordId ?? null }));
  const identities = new Map(await Promise.all(students.map(async student => [student.id, `assigned-${await hashText(`${user.id}:${operationId}:${student.id}`)}`] as const)));
  const previous = await db.prepare(`SELECT a.id,a.sheet_json,s.id AS submission_id FROM homework_assignments a
    LEFT JOIN homework_submissions s ON s.assignment_id=a.id AND s.version=1 WHERE a.owner_user_id=? AND a.id IN (SELECT value FROM json_each(?))`)
    .bind(user.id, JSON.stringify([...identities.values()])).all<{ id: string; sheet_json: string; submission_id: string | null }>();
  const previousRows = previous.results as Array<{ id: string; sheet_json: string; submission_id: string | null }>;
  if (previousRows.some(item => parseJson<HomeworkSheet>(item.sheet_json, {}).requestHash !== requestHash || !item.submission_id)) throw responseError("同一次布置的内容已变化，请完成原操作后重新布置", 409);
  const completed = new Map(previousRows.map(item => [item.id, item.submission_id!]));
  if (completed.size === students.length) return students.map(student => ({ id: completed.get(identities.get(student.id)!)!, studentId: student.id, studentName: student.name }));
  // The record is remembered only when it is this teacher's; the archive then knows the plan is handed out.
  const record = typeof input.recordId === "string" && input.recordId ? await appEnv().DB.prepare("SELECT id FROM typeset_records WHERE id = ? AND owner_user_id = ?")
    .bind(input.recordId, user.id).first<{ id: string }>() : null;
  const sheet: HomeworkSheet = { groups, requestHash, ...(record ? { recordId: record.id } : {}) };
  const registered = completed.size ? [] : await ensureLibraryQuestions(raw, user);
  const library = completed.size ? new Map<string, Question>() : new Map((await readLibrary(user)).questions.map((question) => [question.id, question]));
  const { index: graph } = await (await import("./knowledge-graph")).loadPublishedKnowledgeGraph();
  const questions = [];
  if (completed.size) {
    // A partial retry uses the first student's saved snapshot even if someone has since edited the library.
    const saved = await db.prepare("SELECT * FROM assignment_questions WHERE assignment_id=? ORDER BY sort_order").bind([...completed.keys()][0]).all<Record<string, unknown>>();
    for (const q of saved.results) questions.push({ source: parseJson<Question>(q.source_json, {} as Question), type: q.type as QuestionType, stem: String(q.stem),
      answer: String(q.answer), analysis: String(q.analysis), tags: parseJson<string[]>(q.knowledge_tags_json, []), taxonomyKeys: parseJson<string[]>(q.taxonomy_keys_json, []),
      options: parseJson<string[]>(q.options_json, []), reference: Boolean(q.reference_verified), fromLibrary: q.reference_evidence === "题库原题答案" });
  } else for (const item of registered) {

    const fromLibrary = library.get(String(item.id ?? ""));
    const copy = givenQuestion(fromLibrary ?? item);
    if (new TextEncoder().encode(JSON.stringify(copy)).byteLength > MAX_SOURCE_BYTES) throw responseError("有一道题的内容过大，无法布置", 413);
    const source = copy;
    const type = QUESTION_TYPES.includes(source.type) ? source.type : "解答题";
    const stem = text(source.stem, 100_000), answer = text(source.answer, 100_000), analysis = text(source.analysis, 100_000);
    const tags = Array.isArray(source.tags) ? source.tags.map((tag) => text(tag, 120)).filter(Boolean) : [];
    const taxonomyKeys = fromLibrary && Array.isArray(source.taxonomyKeys) && source.taxonomyKeys.length ? source.taxonomyKeys
      : resolveKnowledgeTaxonomyKeys([...tags, ...testedTopics(analysis)], stem, graph);
    questions.push({ source, type, stem, answer, analysis, tags, taxonomyKeys, options: Array.isArray(source.options) ? source.options.map((option) => text(option, 2_000)) : [],
      reference: hasReference({ answer, analysis }), fromLibrary: Boolean(fromLibrary) });
  }
  // Bound each parameter's payload as well as the question count. Each student's complete material is one transaction.
  const chunks: string[] = []; let chunk: string[] = [], bytes = 2;
  for (const [index, question] of questions.entries()) {
    const value = JSON.stringify({ ...question, index, number: numbers[index], reference: question.reference ? 1 : 0 });
    const size = new TextEncoder().encode(value).byteLength + 1;
    if (size > 1_500_000) throw responseError("有一道题的内容过大，无法布置", 413);
    if (chunk.length && (bytes + size > 1_500_000 || chunk.length >= 50)) { chunks.push(`[${chunk.join(",")}]`); chunk = []; bytes = 2; }
    chunk.push(value); bytes += size;
  }
  if (chunk.length) chunks.push(`[${chunk.join(",")}]`);
  const created: Array<{ id: string; studentId: string; studentName: string }> = [];
  for (const student of students) {
    const assignmentId = identities.get(student.id)!, submissionId = `${assignmentId}-upload-1`, now = Date.now();
    if (!completed.has(assignmentId)) try {
      await db.batch([
        db.prepare(`INSERT INTO homework_assignments(id,owner_user_id,title,instructions,status,template_confirmed,created_at,updated_at,input_mode,outputs_json,curriculum,sheet_json)
          VALUES(?,?,?,'','published',0,?,?,'completed_homework',?,'school',?)`).bind(assignmentId, user.id, title, now, now, JSON.stringify(ASSIGNED_OUTPUTS), JSON.stringify(sheet)),
        ...chunks.map(questionsJson => db.prepare(`INSERT INTO assignment_questions(id,assignment_id,question_number,page_number,type,stem,options_json,answer,analysis,bbox_json,confidence,warnings_json,
            knowledge_tags_json,taxonomy_keys_json,capability_keys_json,sort_order,created_at,updated_at,reference_source,reference_verified,reference_evidence,input_evidence_json,source_json)
          SELECT ?||'-q-'||json_extract(value,'$.index'),?,json_extract(value,'$.number'),0,json_extract(value,'$.type'),json_extract(value,'$.stem'),
            json_extract(value,'$.options'),json_extract(value,'$.answer'),json_extract(value,'$.analysis'),NULL,1,'[]',json_extract(value,'$.tags'),json_extract(value,'$.taxonomyKeys'),'[]',
            json_extract(value,'$.index'),?,?,CASE WHEN json_extract(value,'$.reference')=1 THEN 'provided' ELSE 'unresolved' END,json_extract(value,'$.reference'),
            CASE WHEN json_extract(value,'$.reference')=0 THEN '布置时没有答案，批改时由 AI 解题并核验' WHEN json_extract(value,'$.fromLibrary')=1 THEN '题库原题答案' ELSE '布置时资料自带的答案' END,
            '{}',json_extract(value,'$.source') FROM json_each(?)`).bind(assignmentId, assignmentId, now, now, questionsJson)),
        db.prepare("INSERT INTO homework_submissions(id,assignment_id,student_id,version,status,submitted_by_type,submitted_by_id,created_at,updated_at) VALUES(?,?,?,1,'draft','teacher',?,?,?)")
          .bind(submissionId, assignmentId, student.id, user.id, now, now),
      ]);
    } catch (error) {
      // Concurrent retries race on the same primary key. Only a fully committed, matching operation counts as success.
      const raced = await db.prepare("SELECT a.sheet_json,s.id FROM homework_assignments a JOIN homework_submissions s ON s.assignment_id=a.id AND s.version=1 WHERE a.id=? AND a.owner_user_id=?")
        .bind(assignmentId, user.id).first<{ sheet_json: string; id: string }>();
      if (raced && parseJson<HomeworkSheet>(raced.sheet_json, {}).requestHash !== requestHash) throw responseError("同一次布置的内容已变化，请刷新后重试", 409);
      if (!raced) {
        console.error("布置未完成", error);
        throw new Response(JSON.stringify({ error: `已布置 ${created.length}/${students.length} 位学生${created.length ? `（${created.map(item => item.studentName).join("、")}）` : ""}，其余未完成。请点重试继续本次布置，已成功的不会重复。`, assigned: created }),
          { status: 503, headers: { "Content-Type": "application/json" } });
      }
    }
    created.push({ id: completed.get(assignmentId) ?? submissionId, studentId: student.id, studentName: student.name });
  }
  return created;
}

/**
 * The teacher's homework for the archive (one student's, or every student's), newest first, each with the student it
 * belongs to: an assigned homework counts its whole sheet (handed-in questions against all of them) day by day, an
 * uploaded one the questions its last upload found.
 */
async function teacherHomework(user: AuthUser, studentId?: string) {
  const rows = await appEnv().DB.prepare(`${SUBMISSION_SELECT} AND homework_assignments.status<>'archived' AND homework_assignments.owner_user_id=?${studentId ? " AND homework_submissions.student_id=?" : ""}
    AND NOT EXISTS (SELECT 1 FROM homework_submissions newer WHERE newer.assignment_id=homework_submissions.assignment_id AND newer.student_id=homework_submissions.student_id AND newer.version>homework_submissions.version)
    ORDER BY homework_assignments.created_at DESC,homework_submissions.id DESC`).bind(user.id, ...(studentId ? [studentId] : [])).all<Record<string, unknown>>();
  const latest = rows.results as Record<string, unknown>[];
  const [assignedById, uploads] = await Promise.all([assignedHomework(latest, false), uploadResults(latest.filter(row => !row.sheet_json && row.status === "published").map(row => String(row.id)))]);
  return latest.map((row): { studentId: string; homework: StudentHomework } => {
    const assigned = assignedById.get(String(row.id));
    const results = assigned ? assigned.questions.flatMap(question => question.result ?? []) : uploads.get(String(row.id)) ?? [];
    return { studentId: String(row.student_id), homework: {
      assignmentId: String(row.assignment_id), title: String(row.assignment_title), assigned: Boolean(assigned), createdAt: Number(row.assignment_created_at),
      total: assigned ? assigned.questions.length : results.length, ...tally(results),
      latest: { id: String(row.id), status: row.status as SubmissionStatus, version: Number(row.version), updatedAt: Number(row.updated_at) },
      days: assigned?.days ?? null, recordId: assigned ? parseJson<HomeworkSheet>(row.sheet_json, {}).recordId ?? null : null,
    } };
  });
}

export async function readStudentHomework(studentId: string, user: AuthUser): Promise<StudentHomework[]> {
  await ownedStudent(studentId, user.id);
  return (await teacherHomework(user, studentId)).map((entry) => entry.homework);
}

/** The badges beside every student in 学生档案 in one read; students with neither 批改中 nor 作业中 are left out. */
export async function readHomeworkProgress(user: AuthUser) {
  const db = appEnv().DB;
  const rows = await db.prepare(`SELECT s.id,s.assignment_id,s.student_id,s.status,a.curriculum,a.sheet_json<>'' AS assigned
    FROM homework_submissions s JOIN homework_assignments a ON a.id=s.assignment_id
    WHERE a.owner_user_id=? AND a.input_mode='completed_homework' AND a.status<>'archived'
      AND NOT EXISTS (SELECT 1 FROM homework_submissions newer WHERE newer.assignment_id=s.assignment_id AND newer.student_id=s.student_id AND newer.version>s.version)`)
    .bind(user.id).all<{ id: string; assignment_id: string; student_id: string; status: SubmissionStatus; curriculum: string; assigned: number }>();
  const progress: Record<string, "grading" | "assigned"> = {};
  const latestRows = rows.results as Array<{ id: string; assignment_id: string; student_id: string; status: SubmissionStatus; curriculum: string; assigned: number }>;
  for (const row of latestRows) if (["submitted", "processing"].includes(row.status)) progress[row.student_id] = "grading";
  const pending = latestRows.filter(row => row.assigned && progress[row.student_id] !== "grading");
  for (const row of pending) if (row.status !== "published") progress[row.student_id] = "assigned";
  const candidates = pending.filter(row => row.status === "published" && !progress[row.student_id]);
  if (!candidates.length) return progress;
  const ids = JSON.stringify([...new Set(candidates.map(row => row.assignment_id))]);
  const [questions, uploads] = await Promise.all([
    db.prepare("SELECT assignment_id,id FROM assignment_questions WHERE assignment_id IN (SELECT value FROM json_each(?)) AND source_json<>''").bind(ids).all<{ assignment_id: string; id: string }>(),
    db.prepare("SELECT id,assignment_id,student_id FROM homework_submissions WHERE assignment_id IN (SELECT value FROM json_each(?)) AND status='published' ORDER BY version")
      .bind(ids).all<{ id: string; assignment_id: string; student_id: string }>(),
  ]);
  const uploadRows = uploads.results as Array<{ id: string; assignment_id: string; student_id: string }>;
  const questionRows = questions.results as Array<{ assignment_id: string; id: string }>;
  const results = await uploadResults(uploadRows.map(upload => upload.id));
  // Badges need only the latest settled results and question IDs, not sheet bodies, day history or grading evidence.
  const byAssignment = new Map<string, typeof questionRows>(), latest = new Map<string, Map<string, Awaited<ReturnType<typeof uploadResults>> extends Map<string, (infer T)[]> ? T : never>>();
  for (const question of questionRows) { const group = byAssignment.get(question.assignment_id) ?? []; group.push(question); byAssignment.set(question.assignment_id, group); }
  for (const upload of uploadRows) {
    const key = `${upload.assignment_id}:${upload.student_id}`, values = latest.get(key) ?? new Map();
    for (const result of results.get(upload.id) ?? []) values.set(result.assignmentQuestionId, result);
    latest.set(key, values);
  }
  for (const row of candidates) {
    const sheet = byAssignment.get(row.assignment_id) ?? [], values = latest.get(`${row.assignment_id}:${row.student_id}`);
    const unfinished = sheet.some(question => {
      const result = values?.get(question.id);
      if (!result) return true;
      const marked = homeworkCurriculum(row.curriculum) === "school" && ["partial", "unreadable", "review_required"].includes(result.verdict)
        ? { ...result, verdict: "incorrect" as const, requiresReview: false } : result;
      return isPendingGradingItem(marked);
    });
    if (unfinished) progress[row.student_id] = "assigned";
  }
  return progress;
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
  const previousAssets = await appEnv().DB.prepare(`SELECT DISTINCT homework_assets.id, homework_assets.r2_key FROM submission_pages
    JOIN homework_assets ON homework_assets.id = submission_pages.original_asset_id OR homework_assets.id = submission_pages.processed_asset_id
    WHERE submission_pages.submission_id = ?`).bind(id).all<{ id: string; r2_key: string }>();
  const db = appEnv().DB, now = Math.max(Date.now(), Number(row.updated_at) + 1);
  const removed = (previousAssets.results as Array<{ id: string; r2_key: string }>).filter(asset => !assetIds.includes(asset.id));
  const changes = [
    db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM homework_submissions s JOIN homework_assignments a ON a.id=s.assignment_id
      WHERE s.id=? AND s.status='draft' AND s.updated_at=? AND a.owner_user_id=? AND a.status<>'archived')
      AND (SELECT COUNT(*) FROM homework_assets WHERE owner_user_id=? AND upload_submission_id=? AND role='submission_original'
        AND content_type<>'application/pdf' AND id IN (SELECT value FROM json_each(?)))=?
      THEN 1 ELSE json_extract('page save conflict', '$') END AS valid`)
      .bind(id, row.updated_at, user.id, user.id, id, JSON.stringify(assetIds), new Set(assetIds).size),
    db.prepare("DELETE FROM submission_pages WHERE submission_id=?").bind(id),
    // One set-based insert also keeps 30-page saves below D1's per-invocation query budget.
    db.prepare(`INSERT INTO submission_pages(id,submission_id,original_asset_id,processed_asset_id,page_order,created_at)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.assetId'),json_extract(value,'$.assetId'),CAST(key AS INTEGER),? FROM json_each(?)`)
      .bind(id, now, JSON.stringify(assetIds.map(assetId => ({ id: crypto.randomUUID(), assetId })))),
    db.prepare("UPDATE homework_submissions SET updated_at=? WHERE id=?").bind(now, id),
    db.prepare("DELETE FROM homework_assets WHERE owner_user_id=? AND id IN (SELECT value FROM json_each(?))").bind(user.id, JSON.stringify(removed.map(asset => asset.id))),
  ];
  try { await scheduleHomeworkAssetCleanup(user.id, removed.map(asset => asset.r2_key), changes); }
  catch (error) {
    if (error instanceof Error && /malformed JSON/.test(error.message)) throw responseError("作业状态或页面已变化，请刷新后重试", 409);
    throw error;
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
  if (row.grading_run_id || String(row.failure_reason).startsWith("修正已保存")) throw responseError("修正结果正在等待同步，请先完成发布", 409);
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
  const row = await teacherSubmissionRow(id, user), db = appEnv().DB;
  const binary = Boolean(row.sheet_json) && homeworkCurriculum(row.curriculum) === "school";
  if (row.status !== "published" || row.grading_run_id) throw responseError("只有已发布且处理完成的结果可以修正", 409);
  if (!items.length || items.length > 200 || new Set(items.map(item => item.id)).size !== items.length) throw responseError("请选择需要修正的题目，不能重复提交同一题", 400);
  const existingRows = await db.prepare(`SELECT g.*,q.answer AS standard_answer,q.analysis AS standard_analysis,q.reference_source,q.reference_evidence,
    q.reference_verified,q.stem,q.input_evidence_json,q.updated_at AS question_updated_at FROM grading_items g
    JOIN assignment_questions q ON q.id=g.assignment_question_id WHERE g.submission_id=? AND g.id IN (SELECT value FROM json_each(?))`)
    .bind(id, JSON.stringify(items.map(item => item.id))).all<Record<string, unknown>>();
  const existingItems = existingRows.results as Record<string, unknown>[];
  const byId = new Map(existingItems.map(item => [String(item.id), item]));
  const now = Math.max(Date.now(), Number(row.updated_at) + 1, ...existingItems.map(item => Number(item.question_updated_at) + 1)), questions = [], grades = [], revisions = [];
  // Validate every patch before constructing the single commit. No question or history is written by a rejected request.
  for (const patch of items) {
    if (!VERDICTS.includes(patch.verdict as GradingVerdict)) throw responseError("批改结论无效", 400);
    if (binary && !["correct", "incorrect"].includes(String(patch.verdict))) throw responseError("这份作业只判正确或错误", 400);
    const existing = byId.get(patch.id);
    if (!existing) throw responseError("批改项不存在", 404);
    const referenceChanged = Boolean(patch.standardAnswer?.trim() && (patch.standardAnswer !== existing.standard_answer
      || patch.standardAnalysis !== undefined && patch.standardAnalysis !== existing.standard_analysis || patch.referenceVerified === true && !Number(existing.reference_verified)));
    if (referenceChanged && patch.referenceVerified !== true) throw responseError("请先补充并确认本题参考答案", 400);
    const referenceVerified = referenceChanged || Number(existing.reference_verified) === 1;
    if (["correct", "partial", "incorrect"].includes(String(patch.verdict)) && !referenceVerified && !teacherMark(existing.input_evidence_json)) throw responseError("请先补充并确认本题参考答案", 400);
    const evidence = parseJson<Record<string, unknown>>(existing.input_evidence_json, {});
    const maxScore = binary ? null : patch.maxScore === undefined ? normalizeMaxScore(evidence.max_score) : normalizeMaxScore(patch.maxScore);
    const marked = reconcileHomeworkScore(patch.verdict as GradingVerdict, patch.score !== undefined ? patch.score : patch.verdict === existing.verdict ? existing.score : null, maxScore, homeworkCurriculum(row.curriculum));
    const question = { id: existing.assignment_question_id, answer: referenceChanged ? text(patch.standardAnswer, 100_000) : existing.standard_answer,
      analysis: referenceChanged ? text(patch.standardAnalysis ?? existing.standard_analysis, 100_000) : existing.standard_analysis,
      stem: patch.stem?.trim() ? text(patch.stem, 100_000) : existing.stem, referenceVerified: referenceVerified ? 1 : 0,
      referenceSource: referenceChanged ? "provided" : existing.reference_source, referenceEvidence: referenceChanged ? "教师补充并确认参考解答" : existing.reference_evidence,
      evidence: JSON.stringify({ ...evidence, max_score: maxScore }) };
    const next = { id: patch.id, verdict: marked.verdict, score: marked.score, studentAnswer: text(patch.studentAnswer ?? existing.student_answer, 100_000),
      feedback: text(patch.feedback ?? existing.feedback, 4_000), errorType: text(patch.errorType ?? existing.error_type, 120),
      stepAnalysis: patch.stepAnalysis ?? parseJson<string[]>(existing.step_analysis_json, []), evidenceSummary: text(patch.evidenceSummary ?? existing.evidence_summary, 1_000),
      capabilityKeys: patch.capabilityKeys ?? parseJson<string[]>(existing.capability_keys_json, []), confidence: Math.max(0, Math.min(1, Number(patch.confidence ?? existing.confidence) || 0)),
      requiresReview: ["unreadable", "review_required"].includes(marked.verdict) ? 1 : 0 };
    questions.push(question); grades.push(next);
    revisions.push({ id: crypto.randomUUID(), itemId: patch.id, before: JSON.stringify(existing), after: JSON.stringify({ ...next, question }) });
  }
  try { await db.batch([
    db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM homework_submissions s JOIN homework_assignments a ON a.id=s.assignment_id
      WHERE s.id=? AND s.status='published' AND s.grading_run_id='' AND s.updated_at=? AND a.owner_user_id=? AND a.status<>'archived')
      AND NOT EXISTS (SELECT 1 FROM json_each(?) expected LEFT JOIN assignment_questions q ON q.id=json_extract(expected.value,'$.assignment_question_id')
        WHERE q.id IS NULL OR q.updated_at<>json_extract(expected.value,'$.question_updated_at'))
      THEN 1 ELSE json_extract('correction conflict', '$') END AS valid`).bind(id, row.updated_at, user.id, JSON.stringify(existingItems)),
    db.prepare(`UPDATE assignment_questions SET (answer,analysis,stem,reference_verified,reference_source,reference_evidence,input_evidence_json)=
      (SELECT json_extract(value,'$.answer'),json_extract(value,'$.analysis'),json_extract(value,'$.stem'),json_extract(value,'$.referenceVerified'),
        json_extract(value,'$.referenceSource'),json_extract(value,'$.referenceEvidence'),json_extract(value,'$.evidence') FROM json_each(?) WHERE json_extract(value,'$.id')=assignment_questions.id),updated_at=?
      WHERE assignment_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`).bind(JSON.stringify(questions), now, row.assignment_id, JSON.stringify(questions)),
    db.prepare(`INSERT INTO grading_item_revisions(id,grading_item_id,submission_id,corrected_by,before_json,after_json,created_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.itemId'),?,?,json_extract(value,'$.before'),json_extract(value,'$.after'),? FROM json_each(?)`)
      .bind(id, user.id, now, JSON.stringify(revisions)),
    db.prepare(`UPDATE grading_items SET (verdict,score,student_answer,feedback,error_type,step_analysis_json,evidence_summary,capability_keys_json,confidence,requires_review)=
      (SELECT json_extract(value,'$.verdict'),json_extract(value,'$.score'),json_extract(value,'$.studentAnswer'),json_extract(value,'$.feedback'),json_extract(value,'$.errorType'),
        json_extract(value,'$.stepAnalysis'),json_extract(value,'$.evidenceSummary'),json_extract(value,'$.capabilityKeys'),json_extract(value,'$.confidence'),json_extract(value,'$.requiresReview')
        FROM json_each(?) WHERE json_extract(value,'$.id')=grading_items.id),reviewed_by=?,reviewed_at=?,corrected_at=?,wrong_book_applied_at=NULL,bbox_json=json_remove(bbox_json,'$.errors'),updated_at=?
      WHERE submission_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`).bind(JSON.stringify(grades), user.id, now, now, now, id, JSON.stringify(grades)),
    // Reuse the existing ready -> publish lifecycle as a durable output checkpoint; the revision is already saved.
    db.prepare("UPDATE homework_submissions SET status='ready',published_at=COALESCE(published_at,?),failure_reason='修正已保存，结果同步待重试',updated_at=? WHERE id=?").bind(now, now, id),
  ]); } catch (error) {
    if (error instanceof Error && /malformed JSON/.test(error.message)) throw responseError("批改结果已变化，请刷新后重试", 409);
    throw error;
  }
  return publishSubmission(id, user);
}

export async function publishSubmission(id: string, user: AuthUser) {
  const row = await teacherSubmissionRow(id, user);
  if (row.status === "ready" && String(row.failure_reason).startsWith("修正已保存")) {
    const db = appEnv().DB, token = crypto.randomUUID(), now = Date.now();
    const claimed = await db.prepare(`UPDATE homework_submissions SET grading_run_id=?,updated_at=? WHERE id=? AND status='ready'
      AND failure_reason LIKE '修正已保存%' AND (grading_run_id='' OR updated_at<?)
      AND EXISTS (SELECT 1 FROM homework_assignments WHERE id=homework_submissions.assignment_id AND status<>'archived')`)
      .bind(token, now, id, now - 300_000).run();
    if (!claimed.meta.changes) throw responseError("结果正在同步，请稍后刷新", 409);
    const heartbeat = setInterval(() => { void db.prepare("UPDATE homework_submissions SET updated_at=? WHERE id=? AND grading_run_id=?")
      .bind(Date.now(), id, token).run().catch(() => {}); }, 30_000);
    try {
      await withHomeworkGradingRun(id, token, new AbortController().signal, async () => {
        await (await import("./homework-outputs")).applySubmissionOutputs(await readTeacherSubmission(id, user), user, { refreshReport: true });
        await homeworkDb().prepare("UPDATE homework_submissions SET status='published',failure_reason='',grading_run_id='',updated_at=MAX(updated_at+1,?) WHERE id=?")
          .bind(Date.now(), id).run();
      });
    } catch (error) {
      await db.prepare("UPDATE homework_submissions SET failure_reason=?,grading_run_id='',updated_at=? WHERE id=? AND grading_run_id=?")
        .bind(`修正已保存，结果同步待重试：${error instanceof Error ? error.message.slice(0, 300) : "同步失败"}`, Date.now(), id, token).run();
    } finally { clearInterval(heartbeat); }
    return readTeacherSubmission(id, user);
  }
  try { await (await import("./homework-page-coverage")).assertCompletePageCoverage(id); } catch(error) { throw responseError(error instanceof Error?error.message:"页面尚未全部核验",409); }
  const { applySubmissionOutputs } = await import("./homework-outputs");
  if (!["ready", "published"].includes(String(row.status))) throw responseError("仍有题目需要复核，暂不能发布", 409);
  let submission = await submissionDetails(row);
  if (!submission.gradingItems.length) throw responseError("没有可发布的批改结果", 409);
  // Also fill historical gaps when publishing; complete explanations never trigger another model call.
  if (await (await import("./completed-homework-grading")).locateHomeworkErrors(submission)) submission = await submissionDetails(row);
  if (row.status === "published") {
    // Re-publishing an older snapshot cannot overwrite outputs after a concurrent correction commits.
    await withHomeworkGradingRun(id, String(row.grading_run_id ?? ""), new AbortController().signal,
      () => applySubmissionOutputs(submission, user), Number(row.updated_at));
    return readTeacherSubmission(id, user);
  }
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
    WHERE g.submission_id=? AND (g.requires_review=1 OR g.verdict IN ('unreadable','review_required') OR (g.verdict IN ('incorrect','partial') AND ((trim(q.answer)='' AND trim(q.analysis)='') OR q.reference_verified=0)))`).bind(id).all<{assignment_question_id:string}>();
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
    AND ((trim(answer)='' AND trim(analysis)='') OR reference_verified=0) AND reference_fingerprint NOT LIKE 'pending:%' AND reference_evidence NOT LIKE '教师补充并确认%'`).bind(id));
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
  await scheduleHomeworkAssetCleanup(ownerUserId, assets.map((asset) => asset.r2_key), [appEnv().DB.prepare("DELETE FROM homework_assets WHERE owner_user_id=? AND id IN (SELECT value FROM json_each(?))")
    .bind(ownerUserId, JSON.stringify(assets.map(asset => asset.id)))]);
}

export function homeworkDb() { return appEnv().DB; }
