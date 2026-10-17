import { env } from "cloudflare:workers";
import { WRONG_QUESTION_DELETED, type AuthUser, type Question, type Student, type StudentSummary, type WrongQuestionEntry } from "../types";

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
      students.created_at, students.updated_at,
      COUNT(student_wrong_questions.id) AS wrong_count
    FROM students
    LEFT JOIN student_wrong_questions ON student_wrong_questions.student_id = students.id
      AND student_wrong_questions.owner_user_id = students.owner_user_id AND student_wrong_questions.archived_at IS NULL
    WHERE students.owner_user_id = ?
    GROUP BY students.id
    ORDER BY students.updated_at DESC, students.created_at DESC`).bind(user.id).all<Record<string, unknown>>();
  return result.results.map((row: Record<string, unknown>) => ({
    ...toStudent(row),
    wrongCount: Number(row.wrong_count ?? 0),
  }));
}

export async function readStudentClasses(user: AuthUser): Promise<string[]> {
  const rows = await appEnv().DB.prepare("SELECT name FROM student_classes WHERE owner_user_id = ? ORDER BY name")
    .bind(user.id).all<{ name: string }>();
  return rows.results.map((row: { name: string }) => row.name);
}

/** One class per student, using the existing class_name. Updating a class never changes a student's work. */
export async function saveStudentClass(raw: { name?: unknown; studentIds?: unknown }, user: AuthUser, previousName?: string) {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 80) throw responseError("请填写 1–80 字的班级名称", 400);
  if (!Array.isArray(raw.studentIds) || raw.studentIds.length > 200 || raw.studentIds.some((id) => typeof id !== "string" || !id)) {
    throw responseError("请选择班级学生", 400);
  }
  const ids = [...new Set(raw.studentIds as string[])];
  const db = appEnv().DB;
  if (previousName !== undefined && !(await db.prepare("SELECT name FROM student_classes WHERE owner_user_id = ? AND name = ?").bind(user.id, previousName).first())) {
    throw responseError("班级不存在", 404);
  }
  const conflict = await db.prepare("SELECT name FROM student_classes WHERE owner_user_id = ? AND name = ?").bind(user.id, name).first();
  if (conflict && previousName !== name) throw responseError("已有同名班级，请使用其他名称", 409);
  // Validate every recipient before changing membership, including students coming from another class.
  const students = await readStudents(user);
  if (ids.some((id) => !students.some((student) => student.id === id))) throw responseError("有学生档案不存在，请刷新后重试", 404);
  const statements = [previousName === undefined
    ? db.prepare("INSERT INTO student_classes (owner_user_id, name) VALUES (?, ?)").bind(user.id, name)
    : db.prepare("UPDATE student_classes SET name = ? WHERE owner_user_id = ? AND name = ?").bind(name, user.id, previousName)];
  const members = new Set(ids), now = Date.now();
  for (const student of students) {
    const nextClass = members.has(student.id) ? name : previousName !== undefined && student.className === previousName ? "" : student.className;
    if (nextClass !== student.className) statements.push(db.prepare("UPDATE students SET class_name = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .bind(nextClass, now, student.id, user.id));
  }
  // D1 batch is a transaction: renaming and moving members either all succeed or all roll back.
  await db.batch(statements);
  return name;
}

export async function deleteStudentClass(name: string, user: AuthUser) {
  const db = appEnv().DB;
  if (!(await db.prepare("SELECT name FROM student_classes WHERE owner_user_id = ? AND name = ?").bind(user.id, name).first())) throw responseError("班级不存在", 404);
  await db.batch([
    db.prepare("UPDATE students SET class_name = '', updated_at = ? WHERE owner_user_id = ? AND class_name = ?").bind(Date.now(), user.id, name),
    db.prepare("DELETE FROM student_classes WHERE owner_user_id = ? AND name = ?").bind(user.id, name),
  ]);
}

export async function createStudent(raw: Partial<Student>, user: AuthUser) {
  const count = await appEnv().DB.prepare("SELECT COUNT(*) AS count FROM students WHERE owner_user_id = ?")
    .bind(user.id).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= 200) throw responseError("学生档案已达到 200 个上限", 400);
  const input = cleanStudentInput(raw);
  const now = Date.now();
  const student: Student = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
  const statements = [appEnv().DB.prepare(`INSERT INTO students
    (id, owner_user_id, name, class_name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(student.id, user.id, student.name, student.className, student.notes, now, now)];
  if (input.className) statements.push(appEnv().DB.prepare("INSERT OR IGNORE INTO student_classes (owner_user_id, name) VALUES (?, ?)").bind(user.id, input.className));
  await appEnv().DB.batch(statements);
  return student;
}

export async function updateStudent(id: string, raw: Partial<Student>, user: AuthUser) {
  const existing = await ownedStudent(id, user);
  const input = cleanStudentInput(raw);
  const updatedAt = Date.now();
  const statements = [appEnv().DB.prepare(`UPDATE students SET name = ?, class_name = ?, notes = ?, updated_at = ?
    WHERE id = ? AND owner_user_id = ?`).bind(input.name, input.className, input.notes, updatedAt, id, user.id)];
  if (input.className) statements.push(appEnv().DB.prepare("INSERT OR IGNORE INTO student_classes (owner_user_id, name) VALUES (?, ?)").bind(user.id, input.className));
  await appEnv().DB.batch(statements);
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
      question_snapshot_json, mistake_count, last_wrong_at, created_at, updated_at,
      source_kind, assignment_id, submission_id, grading_item_id, student_answer, feedback, answer_crop_asset_id, archived_at, archive_reason
    FROM student_wrong_questions WHERE student_id = ? AND owner_user_id = ? ${includeHistory ? "" : "AND archived_at IS NULL"}
    ORDER BY last_wrong_at DESC, created_at DESC`).bind(studentId, user.id).all<Record<string, unknown>>();
  return result.results.map(toWrongQuestion);
}

/** 删除只是移入“历史记录”，可以恢复；之后学生再次做错这道题时，它会重新回到错题本。 */
export async function deleteWrongQuestion(studentId: string, entryId: string, user: AuthUser) {
  await ownedStudent(studentId, user);
  const now = Date.now();
  const result = await appEnv().DB.prepare(`UPDATE student_wrong_questions SET archived_at = ?, archive_reason = ?, updated_at = ?
    WHERE id = ? AND student_id = ? AND owner_user_id = ? AND archived_at IS NULL`).bind(now, WRONG_QUESTION_DELETED, now, entryId, studentId, user.id).run();
  if (!result.meta.changes) throw responseError("错题记录不存在", 404);
}

export async function restoreWrongQuestion(studentId: string, entryId: string, user: AuthUser) {
  await ownedStudent(studentId, user);
  const result = await appEnv().DB.prepare(`UPDATE student_wrong_questions SET archived_at = NULL, archive_reason = '', updated_at = ?
    WHERE id = ? AND student_id = ? AND owner_user_id = ? AND archive_reason = ?`).bind(Date.now(), entryId, studentId, user.id, WRONG_QUESTION_DELETED).run();
  if (!result.meta.changes) throw responseError("历史记录中没有这道被删除的错题", 404);
}
