import { env } from "cloudflare:workers";
import { coursePath, handoutModules, handoutOutline, normalizeHandoutDraft, normalizeHandoutGroup, sheetCounts } from "../handout-rules.mjs";
import { prepareQuestion, requireAdmin, resolveLibraryContext, retainQuestionAssetsForUser, teacherNamespaceId } from "./library";
import type { AuthUser, CourseLessonDetail, Handout, HandoutCourseNode, HandoutGrade, HandoutGroup, HandoutSummary, Question } from "../types";

type AppEnv = { DB: D1Database };
type HandoutRow = { id: string; title: string; items_json: string; course_unit_id: string | null; domain: string | null; student_id: string | null; student_name: string | null; position: number; created_at: number; updated_at: number };

// D1 caps a row at 2 MB; media stays in the existing chunked asset store.
const MAX_ITEMS_BYTES = 1_900_000;
// 学生讲义只属于学生的老师：其他老师读不到、改不到这些行，和学生档案一样。
const SELECT_VISIBLE = `SELECT handouts.id, handouts.title, handouts.items_json, handouts.course_unit_id, handouts.domain, handouts.student_id,
    students.name AS student_name, handouts.position, handouts.created_at, handouts.updated_at
  FROM handouts LEFT JOIN students ON students.id = handouts.student_id
  WHERE (handouts.student_id IS NULL OR students.owner_user_id = ?)`;
const WRITABLE = "(student_id IS NULL OR student_id IN (SELECT id FROM students WHERE owner_user_id = ?))";
const NO_GROUP: HandoutGroup = { courseUnitId: null, domain: null, studentId: null };
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

const storedGroup = (row: Pick<HandoutRow, "course_unit_id" | "domain" | "student_id">) => normalizeHandoutGroup({ courseUnitId: row.course_unit_id, domain: row.domain, studentId: row.student_id }) ?? NO_GROUP;

function toHandout(row: HandoutRow, nodes: HandoutCourseNode[] = []): Handout {
  let stored: { items?: unknown; temporaryQuestions?: Question[] } = {};
  try { const raw = JSON.parse(row.items_json); stored = Array.isArray(raw) ? { items: raw } : raw ?? {}; } catch { /* Older rows store just the items array. */ }
  const group = storedGroup(row);
  return {
    id: row.id, title: row.title, coursePath: coursePath(nodes, row.course_unit_id), items: normalizeHandoutDraft({ title: row.title, items: stored.items }).items,
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

async function groupOf(raw: unknown) {
  const group = normalizeHandoutGroup(raw);
  if (!group) throw responseError("讲义位置无效", 400);
  if (group.courseUnitId && coursePath(await listHandoutCourses(), group.courseUnitId).length !== 3) throw responseError("请选择存在的学期或单元", 400);
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
  const nodes = await listHandoutCourses();
  return rows.results.map((row) => {
    const { items, temporaryQuestions, ...summary } = toHandout(row, nodes);
    void temporaryQuestions; // The directory never carries imported question bodies.
    return { ...summary, outline: handoutOutline(items), sheetCounts: sheetCounts(items) };
  });
}

export async function getHandout(user: AuthUser, id: string): Promise<Handout> {
  const row = await db().prepare(`${SELECT_VISIBLE} AND handouts.id = ?`).bind(user.id, id).first<HandoutRow>();
  if (!row) throw responseError("讲义不存在", 404);
  return toHandout(row, await listHandoutCourses());
}

// 课程体系和专题库全员共用：任何登录老师都能查看和编辑，owner_user_id 只记录创建人；删除需要管理员。
// A new handout becomes the last of its group.
export async function createHandout(user: AuthUser, raw: unknown): Promise<Handout> {
  const group = await groupOf(raw);
  const studentName = group.studentId ? await ownStudentName(user, group.studentId) : null;
  const { title, items, temporaryQuestions, itemsJson } = await encode(raw, user, [], group.studentId);
  const id = crypto.randomUUID(); const now = Date.now();
  const row = await db().prepare(`INSERT INTO handouts (id, title, items_json, course_unit_id, domain, student_id, position, created_at, updated_at, owner_user_id)
    SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, ? FROM handouts WHERE course_unit_id IS ? AND domain IS ? AND student_id IS ?
    RETURNING position`).bind(id, title, itemsJson, group.courseUnitId, group.domain, group.studentId, now, now, user.id, group.courseUnitId, group.domain, group.studentId).first<{ position: number }>();
  return { id, title, items, temporaryQuestions, ...group, coursePath: coursePath(await listHandoutCourses(), group.courseUnitId), studentName, position: row?.position ?? 0, createdAt: now, updatedAt: now };
}

export async function updateHandout(user: AuthUser, id: string, raw: unknown): Promise<Handout> {
  const previous = await getHandout(user, id);
  const { title, items, temporaryQuestions, itemsJson } = await encode(raw, user, previous.temporaryQuestions, previous.studentId);
  const now = Date.now();
  const row = await db().prepare(`UPDATE handouts SET title = ?, items_json = ?, updated_at = ?
    WHERE id = ? AND ${WRITABLE} RETURNING course_unit_id, domain, student_id, position, created_at`).bind(title, itemsJson, now, id, user.id)
    .first<Pick<HandoutRow, "course_unit_id" | "domain" | "student_id" | "position" | "created_at">>();
  if (!row) throw responseError("讲义不存在", 404);
  const group = storedGroup(row);
  const studentName = group.studentId ? await ownStudentName(user, group.studentId) : null;
  return { id, title, items, temporaryQuestions, ...group, coursePath: coursePath(await listHandoutCourses(), group.courseUnitId), studentName, position: row.position, createdAt: row.created_at, updatedAt: now };
}

// Puts the listed handouts into one group in this order: the 课次 of a term, the topics of a domain or a student's handouts.
// Handouts already in the group but not listed keep their positions; content timestamps are untouched.
export async function arrangeHandouts(user: AuthUser, raw: unknown) {
  const source = raw && typeof raw === "object" ? raw as { ids?: unknown } : {};
  const group = await groupOf(raw);
  if (group.studentId) await ownStudentName(user, group.studentId);
  const ids = Array.isArray(source.ids) ? [...new Set(source.ids.filter((id): id is string => typeof id === "string" && Boolean(id)))] : [];
  if (!ids.length || ids.length > MAX_ARRANGE) throw responseError("讲义列表无效", 400);
  // Moving one's student handout to a shared shelf also shares its temporary figures.
  // Do not inspect or grant media for another teacher's invisible student handout.
  if (!group.studentId) {
    const visible = await db().prepare(`${SELECT_VISIBLE} AND handouts.id IN (SELECT value FROM json_each(?))`).bind(user.id, JSON.stringify(ids)).all<HandoutRow>();
    for (const row of visible.results) if (row.student_id) for (const question of toHandout(row).temporaryQuestions) await retainQuestionAssetsForUser(question, user);
  }
  const statement = db().prepare(`UPDATE handouts SET course_unit_id = ?, domain = ?, student_id = ?, position = ? WHERE id = ? AND ${WRITABLE}`);
  await db().batch(ids.map((id, position) => statement.bind(group.courseUnitId, group.domain, group.studentId, position, id, user.id)));
  return { ...group, ids };
}

// 共享讲义只有管理员能删除；学生讲义由这位学生的老师自己删除。
export async function deleteHandout(user: AuthUser, id: string) {
  const handout = await getHandout(user, id);
  if (!handout.studentId) requireAdmin(user);
  const result = await db().prepare("DELETE FROM handouts WHERE id = ?").bind(id).run();
  if (!result.meta.changes) throw responseError("讲义不存在", 404);
}

// The published Shenzhen graph stays attached to the original three stages.
// Custom systems never blend into that graph merely because their titles match.
export async function readCourseLessons(): Promise<CourseLessonDetail[]> {
  const rows = await db().prepare(`SELECT handouts.*, students.name AS student_name,
      CAST(substr(stage.id, 14) AS INTEGER) AS graph_grade
    FROM handouts
    JOIN handout_course_nodes unit ON unit.id = handouts.course_unit_id
    JOIN handout_course_nodes stage ON stage.id = unit.parent_id
    LEFT JOIN students ON students.id = handouts.student_id
    WHERE stage.parent_id = 'course-default' AND stage.id IN ('course-grade-7', 'course-grade-8', 'course-grade-9')
      AND handouts.student_id IS NULL
    ORDER BY stage.position, unit.position, handouts.position, handouts.created_at`).all<HandoutRow & { graph_grade: HandoutGrade }>();
  return rows.results.map((row) => {
    const { items } = toHandout(row);
    const tested = (sheet: "quiz" | "homework", sectionId: string) => items.filter((item) => item.kind === sheet && item.moduleId === sectionId).length;
    const modules = handoutModules(items).flatMap((module) => module.section ? [{
      id: module.section.id, title: module.section.title,
      counts: { example: module.bands.example.length, practice: module.bands.practice.length, variant: module.bands.variant.length, quiz: tested("quiz", module.section.id), homework: tested("homework", module.section.id) },
    }] : []);
    return { id: row.id, title: row.title, grade: row.graph_grade, modules };
  });
}

export async function listHandoutCourses(): Promise<HandoutCourseNode[]> {
  const rows = await db().prepare("SELECT id, parent_id AS parentId, name, position FROM handout_course_nodes ORDER BY position, id").all<HandoutCourseNode>();
  return rows.results;
}

// A single path manages all three levels; a lesson is still an ordinary handout.
export async function saveHandoutCourse(raw: unknown) {
  const source = raw && typeof raw === "object" ? raw as { id?: unknown; parentId?: unknown; name?: unknown; direction?: unknown } : {};
  const nodes = await listHandoutCourses();
  const existing = source.id === undefined ? null : nodes.find((node) => node.id === source.id);
  if (source.id !== undefined && !existing) throw responseError("大纲位置不存在，请刷新后重试", 404);
  if (existing && source.direction !== undefined) {
    if (source.direction !== -1 && source.direction !== 1) throw responseError("调整方向无效", 400);
    const siblings = nodes.filter((node) => node.parentId === existing.parentId);
    const from = siblings.findIndex((node) => node.id === existing.id); const to = from + source.direction;
    if (to >= 0 && to < siblings.length) {
      [siblings[from], siblings[to]] = [siblings[to], siblings[from]];
      await db().batch(siblings.map((node, position) => db().prepare("UPDATE handout_course_nodes SET position = ? WHERE id = ?").bind(position, node.id)));
    }
    return { id: existing.id, courseNodes: await listHandoutCourses() };
  }
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name || name.length > 80) throw responseError("名称请填写 1 至 80 个字", 400);
  const parentId = existing ? existing.parentId : source.parentId ?? null;
  if (parentId !== null && (typeof parentId !== "string" || !nodes.some((node) => node.id === parentId) || coursePath(nodes, parentId).length >= 3)) throw responseError("请选择体系或年级 / 阶段", 400);
  if (nodes.some((node) => node.parentId === parentId && node.name === name && node.id !== existing?.id)) throw responseError("同一层级已有这个名称", 409);
  const id = existing?.id ?? crypto.randomUUID();
  try {
    if (existing) await db().prepare("UPDATE handout_course_nodes SET name = ? WHERE id = ?").bind(name, id).run();
    else await db().prepare(`INSERT INTO handout_course_nodes (id, parent_id, name, position)
      SELECT ?, ?, ?, COALESCE(MAX(position) + 1, 0) FROM handout_course_nodes WHERE parent_id IS ?`).bind(id, parentId, name, parentId).run();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint/.test(error.message)) throw responseError("同一层级已有这个名称", 409);
    throw error;
  }
  return { id, courseNodes: await listHandoutCourses() };
}

export async function deleteHandoutCourse(user: AuthUser, id: unknown) {
  requireAdmin(user);
  if (typeof id !== "string") throw responseError("大纲位置无效", 400);
  const result = await db().prepare(`DELETE FROM handout_course_nodes WHERE id = ?
    AND NOT EXISTS (SELECT 1 FROM handout_course_nodes child WHERE child.parent_id = ?)
    AND NOT EXISTS (SELECT 1 FROM handouts WHERE course_unit_id = ?)`).bind(id, id, id).run();
  if (!result.meta.changes) throw responseError("请先移走讲义，并删除空的下级目录，再删除这里", 409);
  return { courseNodes: await listHandoutCourses() };
}
