import { env } from "cloudflare:workers";
import { HANDOUT_TERMS, handoutModules, handoutOutline, normalizeHandoutDraft, normalizeHandoutGroup, sheetCounts } from "../handout-rules.mjs";
import { prepareQuestion, requireAdmin, resolveLibraryContext, retainQuestionAssetsForUser, teacherNamespaceId } from "./library";
import type { AuthUser, CourseLessonDetail, Handout, HandoutGrade, HandoutGroup, HandoutSummary, Question } from "../types";

type AppEnv = { DB: D1Database };
type HandoutRow = { id: string; title: string; items_json: string; grade: number | null; term: string | null; domain: string | null; student_id: string | null; student_name: string | null; position: number; created_at: number; updated_at: number };

// D1 caps a row at 2 MB; media stays in the existing chunked asset store.
const MAX_ITEMS_BYTES = 1_900_000;
// 学生讲义只属于学生的老师：其他老师读不到、改不到这些行，和学生档案一样。
const SELECT_VISIBLE = `SELECT handouts.id, handouts.title, handouts.items_json, handouts.grade, handouts.term, handouts.domain, handouts.student_id,
    students.name AS student_name, handouts.position, handouts.created_at, handouts.updated_at
  FROM handouts LEFT JOIN students ON students.id = handouts.student_id
  WHERE (handouts.student_id IS NULL OR students.owner_user_id = ?)`;
const WRITABLE = "(student_id IS NULL OR student_id IN (SELECT id FROM students WHERE owner_user_id = ?))";
const NO_GROUP: HandoutGroup = { grade: null, term: null, domain: null, studentId: null };
// One group never holds anywhere near this many handouts; it bounds a single arrange call.
const MAX_ARRANGE = 200;

function db() {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings.DB;
}

function responseError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

const storedGroup = (row: Pick<HandoutRow, "grade" | "term" | "domain" | "student_id">) => normalizeHandoutGroup({ grade: row.grade, term: row.term, domain: row.domain, studentId: row.student_id }) ?? NO_GROUP;

function toHandout(row: HandoutRow): Handout {
  let stored: { items?: unknown; temporaryQuestions?: Question[] } = {};
  try { const raw = JSON.parse(row.items_json); stored = Array.isArray(raw) ? { items: raw } : raw ?? {}; } catch { /* Older rows store just the items array. */ }
  const group = storedGroup(row);
  return {
    id: row.id, title: row.title, items: normalizeHandoutDraft({ title: row.title, items: stored.items }).items,
    temporaryQuestions: Array.isArray(stored.temporaryQuestions) ? stored.temporaryQuestions : [], ...group,
    studentName: group.studentId ? row.student_name : null, position: row.position, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function encode(raw: unknown, user: AuthUser, previous: Question[] = [], studentId: string | null = null) {
  const draft = normalizeHandoutDraft(raw);
  const incoming = raw && typeof raw === "object" && "temporaryQuestions" in raw ? raw.temporaryQuestions : previous;
  if (!Array.isArray(incoming) || incoming.length > 400) throw responseError("临时题库最多保存 400 道题，请拆分讲义", 400);
  const seen = new Set<string>();
  const temporaryQuestions: Question[] = [];
  const context = incoming.length ? await resolveLibraryContext(user) : null;
  if (context && studentId) Object.assign(context, { libraryId: await teacherNamespaceId(user), scope: "mine", publicationId: null, ownerUserId: user.id });
  for (const question of incoming) {
    if (!question || typeof question.id !== "string" || !question.id.trim() || question.id.length > 200 || seen.has(question.id)
      || typeof question.stem !== "string" || !question.stem.trim() || question.stem.length > 100_000
      || !["单选题", "多选题", "填空题", "判断题", "解答题"].includes(question.type)
      || !["基础", "中等", "提高"].includes(question.difficulty) || !Array.isArray(question.options) || !question.options.every((option: unknown) => typeof option === "string")) {
      throw responseError("临时题目格式无效，请检查题干、题型和选项", 400);
    }
    seen.add(question.id);
    const old = previous.find((item) => item.id === question.id);
    temporaryQuestions.push(old && JSON.stringify(old) === JSON.stringify(question) ? old
      : { ...await prepareQuestion({ ...question, answer: String(question.answer ?? ""), analysis: String(question.analysis ?? ""), source: String(question.source ?? "") }, user, context!), canEdit: true });
  }
  // Reuse items_json, without a parallel table or changing question references.
  const itemsJson = JSON.stringify(temporaryQuestions.length ? { items: draft.items, temporaryQuestions } : draft.items);
  if (new TextEncoder().encode(itemsJson).byteLength > MAX_ITEMS_BYTES) throw responseError("讲义内容过多，请拆成两份", 413);
  return { ...draft, temporaryQuestions, itemsJson };
}

function groupOf(raw: unknown) {
  const group = normalizeHandoutGroup(raw);
  if (!group) throw responseError("讲义位置无效", 400);
  return group;
}

// A student group must be one of the teacher's own students.
async function ownStudentName(user: AuthUser, studentId: string) {
  const row = await db().prepare("SELECT name FROM students WHERE id = ? AND owner_user_id = ?").bind(studentId, user.id).first<{ name: string }>();
  if (!row) throw responseError("学生档案不存在", 404);
  return row.name;
}

export async function listHandouts(user: AuthUser): Promise<HandoutSummary[]> {
  const rows = await db().prepare(`${SELECT_VISIBLE} ORDER BY handouts.position, handouts.created_at`).bind(user.id).all<HandoutRow>();
  return rows.results.map((row) => {
    const { items, temporaryQuestions, ...summary } = toHandout(row);
    void temporaryQuestions; // The directory never carries imported question bodies.
    return { ...summary, outline: handoutOutline(items), sheetCounts: sheetCounts(items) };
  });
}

export async function getHandout(user: AuthUser, id: string): Promise<Handout> {
  const row = await db().prepare(`${SELECT_VISIBLE} AND handouts.id = ?`).bind(user.id, id).first<HandoutRow>();
  if (!row) throw responseError("讲义不存在", 404);
  return toHandout(row);
}

// 课程体系和专题库全员共用：任何登录老师都能查看和编辑，owner_user_id 只记录创建人；删除需要管理员。
// A new handout becomes the last of its group.
export async function createHandout(user: AuthUser, raw: unknown): Promise<Handout> {
  const group = groupOf(raw);
  const studentName = group.studentId ? await ownStudentName(user, group.studentId) : null;
  const { title, items, temporaryQuestions, itemsJson } = await encode(raw, user, [], group.studentId);
  const id = crypto.randomUUID(); const now = Date.now();
  const row = await db().prepare(`INSERT INTO handouts (id, title, items_json, grade, term, domain, student_id, position, created_at, updated_at, owner_user_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, ? FROM handouts WHERE grade IS ? AND term IS ? AND domain IS ? AND student_id IS ?
    RETURNING position`).bind(id, title, itemsJson, group.grade, group.term, group.domain, group.studentId, now, now, user.id, group.grade, group.term, group.domain, group.studentId).first<{ position: number }>();
  return { id, title, items, temporaryQuestions, ...group, studentName, position: row?.position ?? 0, createdAt: now, updatedAt: now };
}

export async function updateHandout(user: AuthUser, id: string, raw: unknown): Promise<Handout> {
  const previous = await getHandout(user, id);
  const { title, items, temporaryQuestions, itemsJson } = await encode(raw, user, previous.temporaryQuestions, previous.studentId);
  const now = Date.now();
  const row = await db().prepare(`UPDATE handouts SET title = ?, items_json = ?, updated_at = ?
    WHERE id = ? AND ${WRITABLE} RETURNING grade, term, domain, student_id, position, created_at`).bind(title, itemsJson, now, id, user.id)
    .first<Pick<HandoutRow, "grade" | "term" | "domain" | "student_id" | "position" | "created_at">>();
  if (!row) throw responseError("讲义不存在", 404);
  const group = storedGroup(row);
  const studentName = group.studentId ? await ownStudentName(user, group.studentId) : null;
  return { id, title, items, temporaryQuestions, ...group, studentName, position: row.position, createdAt: row.created_at, updatedAt: now };
}

// Puts the listed handouts into one group in this order: the 课次 of a term, the topics of a domain or a student's handouts.
// Handouts already in the group but not listed keep their positions; content timestamps are untouched.
export async function arrangeHandouts(user: AuthUser, raw: unknown) {
  const source = raw && typeof raw === "object" ? raw as { ids?: unknown } : {};
  const group = groupOf(raw);
  if (group.studentId) await ownStudentName(user, group.studentId);
  const ids = Array.isArray(source.ids) ? [...new Set(source.ids.filter((id): id is string => typeof id === "string" && Boolean(id)))] : [];
  if (!ids.length || ids.length > MAX_ARRANGE) throw responseError("讲义列表无效", 400);
  // Moving one's student handout to a shared shelf also shares its temporary figures.
  // Do not inspect or grant media for another teacher's invisible student handout.
  if (!group.studentId) {
    const visible = await db().prepare(`${SELECT_VISIBLE} AND handouts.id IN (SELECT value FROM json_each(?))`).bind(user.id, JSON.stringify(ids)).all<HandoutRow>();
    for (const row of visible.results) if (row.student_id) for (const question of toHandout(row).temporaryQuestions) await retainQuestionAssetsForUser(question, user);
  }
  const statement = db().prepare(`UPDATE handouts SET grade = ?, term = ?, domain = ?, student_id = ?, position = ? WHERE id = ? AND ${WRITABLE}`);
  await db().batch(ids.map((id, position) => statement.bind(group.grade, group.term, group.domain, group.studentId, position, id, user.id)));
  return { ...group, ids };
}

// 共享讲义只有管理员能删除；学生讲义由这位学生的老师自己删除。
export async function deleteHandout(user: AuthUser, id: string) {
  const handout = await getHandout(user, id);
  if (!handout.studentId) requireAdmin(user);
  const result = await db().prepare("DELETE FROM handouts WHERE id = ?").bind(id).run();
  if (!result.meta.changes) throw responseError("讲义不存在", 404);
}

// 课程体系 in teaching order (初一暑假第1讲 first) for the course knowledge graph: every lesson with its modules
// and how many 例题, 练习, 变式, 小测 and 作业 questions each module holds. Course handouts are shared, so no owner filter.
type CourseRow = Omit<HandoutRow, "student_name" | "updated_at">;
type PlacedRow = { row: CourseRow; grade: HandoutGrade; term: number };

export async function readCourseLessons(): Promise<CourseLessonDetail[]> {
  const rows = await db().prepare(`SELECT id, title, items_json, grade, term, domain, student_id, position, created_at FROM handouts
    WHERE term IS NOT NULL AND student_id IS NULL`).all<CourseRow>();
  const termRank = (term: string | null) => HANDOUT_TERMS.findIndex((item) => item.value === term);
  return rows.results.flatMap((row: CourseRow): PlacedRow[] => {
    const group = storedGroup(row);
    return group.grade && group.term ? [{ row, grade: group.grade, term: termRank(group.term) }] : [];
  }).sort((left: PlacedRow, right: PlacedRow) => left.grade - right.grade || left.term - right.term || left.row.position - right.row.position || left.row.created_at - right.row.created_at)
    .map(({ row, grade }: PlacedRow) => {
      const { items } = toHandout({ ...row, student_name: null, updated_at: row.created_at });
      const tested = (sheet: "quiz" | "homework", sectionId: string) => items.filter((item) => item.kind === sheet && item.moduleId === sectionId).length;
      const modules = handoutModules(items).flatMap((module) => module.section ? [{
        id: module.section.id, title: module.section.title,
        counts: { example: module.bands.example.length, practice: module.bands.practice.length, variant: module.bands.variant.length, quiz: tested("quiz", module.section.id), homework: tested("homework", module.section.id) },
      }] : []);
      return { id: row.id, title: row.title, grade, modules };
    });
}
