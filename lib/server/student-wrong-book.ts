import { env } from "cloudflare:workers";
import type { AuthUser, Question, Student, StudentSummary, WrongQuestionEntry } from "../types";

type AppEnv = { DB: D1Database };

function appEnv(): AppEnv {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings;
}

function responseError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

function cleanStudentInput(raw: Partial<Student>) {
  const name = String(raw.name ?? "").trim().slice(0, 60);
  const className = String(raw.className ?? "").trim().slice(0, 80);
  const notes = String(raw.notes ?? "").trim().slice(0, 500);
  if (!name) throw responseError("请填写学生姓名或昵称", 400);
  return { name, className, notes };
}

async function ownedStudent(id: string, user: AuthUser) {
  const row = await appEnv().DB.prepare(`SELECT id, name, class_name, notes, created_at, updated_at
    FROM students WHERE id = ? AND owner_user_id = ?`).bind(id, user.id).first<Record<string, unknown>>();
  if (!row) throw responseError("学生档案不存在", 404);
  return row;
}

function toStudent(row: Record<string, unknown>): Student {
  return {
    id: String(row.id),
    name: String(row.name),
    className: String(row.class_name ?? ""),
    notes: String(row.notes ?? ""),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function readStudents(user: AuthUser): Promise<StudentSummary[]> {
  const result = await appEnv().DB.prepare(`SELECT students.id, students.name, students.class_name, students.notes,
      students.created_at, students.updated_at, student_accounts.login_id,
      COUNT(student_wrong_questions.id) AS wrong_count,
      SUM(CASE WHEN student_wrong_questions.mastered = 0 THEN 1 ELSE 0 END) AS reviewing_count,
      SUM(CASE WHEN student_wrong_questions.mastered = 1 THEN 1 ELSE 0 END) AS mastered_count
    FROM students
    LEFT JOIN student_accounts ON student_accounts.student_id = students.id
      AND student_accounts.owner_user_id = students.owner_user_id
    LEFT JOIN student_wrong_questions ON student_wrong_questions.student_id = students.id
      AND student_wrong_questions.owner_user_id = students.owner_user_id AND student_wrong_questions.archived_at IS NULL
    WHERE students.owner_user_id = ?
    GROUP BY students.id, student_accounts.login_id
    ORDER BY students.updated_at DESC, students.created_at DESC`).bind(user.id).all<Record<string, unknown>>();
  return result.results.map((row: Record<string, unknown>) => ({
    ...toStudent(row),
    loginId: String(row.login_id ?? ""),
    wrongCount: Number(row.wrong_count ?? 0),
    reviewingCount: Number(row.reviewing_count ?? 0),
    masteredCount: Number(row.mastered_count ?? 0),
  }));
}

export async function createStudent(raw: Partial<Student>, user: AuthUser) {
  const count = await appEnv().DB.prepare("SELECT COUNT(*) AS count FROM students WHERE owner_user_id = ?")
    .bind(user.id).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= 200) throw responseError("学生档案已达到 200 个上限", 400);
  const input = cleanStudentInput(raw);
  const now = Date.now();
  const student: Student = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
  await appEnv().DB.prepare(`INSERT INTO students
    (id, owner_user_id, name, class_name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(student.id, user.id, student.name, student.className, student.notes, now, now).run();
  return student;
}

export async function updateStudent(id: string, raw: Partial<Student>, user: AuthUser) {
  const existing = await ownedStudent(id, user);
  const input = cleanStudentInput(raw);
  const updatedAt = Date.now();
  await appEnv().DB.prepare(`UPDATE students SET name = ?, class_name = ?, notes = ?, updated_at = ?
    WHERE id = ? AND owner_user_id = ?`).bind(input.name, input.className, input.notes, updatedAt, id, user.id).run();
  return { id, ...input, createdAt: Number(existing.created_at), updatedAt } satisfies Student;
}

export async function deleteStudent(id: string, user: AuthUser) {
  await ownedStudent(id, user);
  const count = await appEnv().DB.prepare(`SELECT COUNT(*) AS count FROM student_wrong_questions
    WHERE student_id = ? AND owner_user_id = ?`).bind(id, user.id).first<{ count: number }>();
  const { deleteStudentHomeworkAssets, deleteHomeworkAssetRows } = await import("./homework");
  const homeworkAssetIds = await deleteStudentHomeworkAssets(id, user.id);
  await appEnv().DB.prepare("DELETE FROM students WHERE id = ? AND owner_user_id = ?").bind(id, user.id).run();
  await deleteHomeworkAssetRows(homeworkAssetIds, user.id);
  return { wrongQuestionCount: Number(count?.count ?? 0) };
}

function cleanQuestionSnapshot(question: Question) {
  const snapshot = { ...question };
  delete snapshot.canEdit;
  delete snapshot.createdBy;
  delete snapshot.createdByEmail;
  return snapshot;
}

function toWrongQuestion(row: Record<string, unknown>): WrongQuestionEntry {
  const question = JSON.parse(String(row.question_snapshot_json)) as Question;
  return {
    id: String(row.id),
    studentId: String(row.student_id),
    sourceScope: row.source_scope === "mine" ? "mine" : "public",
    sourceQuestionId: String(row.source_question_id),
    sourcePath: String(row.source_path ?? ""),
    question: cleanQuestionSnapshot(question),
    mistakeCount: Number(row.mistake_count),
    note: String(row.note ?? ""),
    mastered: Number(row.mastered) === 1,
    lastWrongAt: Number(row.last_wrong_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at), archiveReason: String(row.archive_reason ?? ""),
    sourceKind: row.source_kind === "assignment" ? "assignment" : "library",
    assignmentId: row.assignment_id == null ? null : String(row.assignment_id),
    submissionId: row.submission_id == null ? null : String(row.submission_id),
    gradingItemId: row.grading_item_id == null ? null : String(row.grading_item_id),
    studentAnswer: String(row.student_answer ?? ""),
    feedback: String(row.feedback ?? ""),
    answerCropAssetId: row.answer_crop_asset_id == null ? null : String(row.answer_crop_asset_id),
  };
}

export async function readWrongQuestions(studentId: string, user: AuthUser, includeHistory = false): Promise<WrongQuestionEntry[]> {
  await ownedStudent(studentId, user);
  const result = await appEnv().DB.prepare(`SELECT id, student_id, source_scope, source_question_id, source_path,
      question_snapshot_json, mistake_count, note, mastered, last_wrong_at, created_at, updated_at,
      source_kind, assignment_id, submission_id, grading_item_id, student_answer, feedback, answer_crop_asset_id, archived_at, archive_reason
    FROM student_wrong_questions WHERE student_id = ? AND owner_user_id = ? ${includeHistory ? "" : "AND archived_at IS NULL"}
    ORDER BY mastered ASC, last_wrong_at DESC, created_at DESC`).bind(studentId, user.id).all<Record<string, unknown>>();
  return result.results.map(toWrongQuestion);
}

export async function updateWrongQuestion(studentId: string, entryId: string, raw: Partial<WrongQuestionEntry>, user: AuthUser) {
  await ownedStudent(studentId, user);
  const existing = await appEnv().DB.prepare(`SELECT id, mistake_count, note, mastered FROM student_wrong_questions
    WHERE id = ? AND student_id = ? AND owner_user_id = ?`).bind(entryId, studentId, user.id)
    .first<{ id: string; mistake_count: number; note: string; mastered: number }>();
  if (!existing) throw responseError("错题记录不存在", 404);
  const mistakeCount = Number(existing.mistake_count);
  const note = raw.note == null ? existing.note : String(raw.note).trim().slice(0, 1000);
  const mastered = raw.mastered == null ? Number(existing.mastered) : raw.mastered ? 1 : 0;
  await appEnv().DB.prepare(`UPDATE student_wrong_questions SET mistake_count = ?, note = ?, mastered = ?, updated_at = ?
    WHERE id = ? AND student_id = ? AND owner_user_id = ?`).bind(mistakeCount, note, mastered, Date.now(), entryId, studentId, user.id).run();
}

export async function deleteWrongQuestion(studentId: string, entryId: string, user: AuthUser) {
  await ownedStudent(studentId, user);
  const entry=await appEnv().DB.prepare("SELECT source_kind FROM student_wrong_questions WHERE id=? AND student_id=? AND owner_user_id=?").bind(entryId,studentId,user.id).first<{source_kind:string}>();
  if(entry?.source_kind === "assignment") throw responseError("作业错题请从原作业修正批改结论",409);
  const result = await appEnv().DB.prepare(`DELETE FROM student_wrong_questions
    WHERE id = ? AND student_id = ? AND owner_user_id = ?`).bind(entryId, studentId, user.id).run();
  if (!result.meta.changes) throw responseError("错题记录不存在", 404);
}
