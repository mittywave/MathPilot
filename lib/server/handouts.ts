import { env } from "cloudflare:workers";
import { HANDOUT_TOPIC_ROOT, coursePath, handoutModules, handoutOutline, normalizeHandoutDraft, normalizeHandoutGroup, sheetCounts } from "../handout-rules.mjs";
import { assetIds, prepareQuestion, readAssetForUser, requireAdmin, resolveLibraryContext, retainQuestionAssetsForUser, teacherNamespaceId } from "./library";
import type { AuthUser, CourseLessonDetail, Handout, HandoutCourseNode, HandoutGrade, HandoutGroup, HandoutSummary, Question } from "../types";

type AppEnv = { DB: D1Database };
type HandoutRow = { id: string; title: string; items_json: string; course_unit_id: string | null; domain: string | null; student_id: string | null; student_name: string | null; position: number; created_at: number; updated_at: number };

// D1 caps a row at 2 MB; media stays in the existing chunked asset store.
const MAX_ITEMS_BYTES = 1_900_000;
// Only system roots store privacy. Use the same inherited access rule for reads and writes.
const VISIBLE_COURSES = `WITH RECURSIVE visible_courses(id) AS (
  SELECT id FROM handout_course_nodes WHERE parent_id IS NULL AND (is_private = 0 OR ? = 1)
  UNION ALL SELECT child.id FROM handout_course_nodes child JOIN visible_courses parent ON child.parent_id = parent.id
)`;
const VISIBLE_GROUP = `(course_unit_id IS NULL OR course_unit_id IN (SELECT id FROM visible_courses))
  AND (domain IS NULL OR domain IN (SELECT id FROM visible_courses))`;
// 学生讲义只属于学生的老师：其他老师读不到、改不到这些行，和学生档案一样。
const SELECT_VISIBLE = `${VISIBLE_COURSES} SELECT handouts.id, handouts.title, handouts.items_json, handouts.course_unit_id, handouts.domain, handouts.student_id,
    students.name AS student_name, handouts.position, handouts.created_at, handouts.updated_at
  FROM handouts LEFT JOIN students ON students.id = handouts.student_id
  WHERE (handouts.student_id IS NULL OR students.owner_user_id = ?) AND ${VISIBLE_GROUP}`;
const WRITABLE = `(student_id IS NULL OR student_id IN (SELECT id FROM students WHERE owner_user_id = ?)) AND ${VISIBLE_GROUP}`;
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
    id: row.id, title: row.title, coursePath: coursePath(nodes, group.courseUnitId ?? group.domain), domainName: nodes.find((node) => node.id === group.domain)?.name ?? null, items: normalizeHandoutDraft({ title: row.title, items: stored.items }).items,
    temporaryQuestions: Array.isArray(stored.temporaryQuestions) ? stored.temporaryQuestions : [], ...group,
    studentName: group.studentId ? row.student_name : null, position: row.position, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function encode(raw: unknown, user: AuthUser, previous: Question[] = [], studentId: string | null = null) {
  const draft = normalizeHandoutDraft(raw);
  // Notes can also reference stored images; a public note must not expose a private URL.
  if (user.role !== "admin") for (const id of assetIds(draft.items)) {
    if (!await readAssetForUser(id, user)) throw responseError("配图不存在或无权访问", 403);
  }
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

async function groupOf(user: AuthUser, raw: unknown) {
  const group = normalizeHandoutGroup(raw);
  if (!group) throw responseError("讲义位置无效", 400);
  const path = group.courseUnitId || group.domain ? coursePath(await listHandoutCourses(user), group.courseUnitId ?? group.domain) : [];
  if (group.courseUnitId && (path.length !== 3 || path[0].id === HANDOUT_TOPIC_ROOT)) throw responseError("请选择存在的学期或单元", 400);
  // Old category/outline handouts remain readable; new topic groups use the same domain field.
  if (group.domain && (path[0]?.id !== HANDOUT_TOPIC_ROOT || path.length < 2)) throw responseError("请选择存在的专题分类或系列", 400);
  return group;
}

// A student group must be one of the teacher's own students.
async function ownStudentName(user: AuthUser, studentId: string) {
  const row = await db().prepare("SELECT name FROM students WHERE id = ? AND owner_user_id = ?").bind(studentId, user.id).first<{ name: string }>();
  if (!row) throw responseError("学生档案不存在", 404);
  return row.name;
}

export async function listHandouts(user: AuthUser): Promise<HandoutSummary[]> {
  const rows = await db().prepare(`${SELECT_VISIBLE} ORDER BY handouts.position, handouts.created_at`).bind(user.role === "admin" ? 1 : 0, user.id).all<HandoutRow>();
  const nodes = await listHandoutCourses(user);
  return rows.results.map((row) => {
    const { items, temporaryQuestions, ...summary } = toHandout(row, nodes);
    void temporaryQuestions; // The directory never carries imported question bodies.
    return { ...summary, outline: handoutOutline(items), sheetCounts: sheetCounts(items) };
  });
}

export async function getHandout(user: AuthUser, id: string): Promise<Handout> {
  const row = await db().prepare(`${SELECT_VISIBLE} AND handouts.id = ?`).bind(user.role === "admin" ? 1 : 0, user.id, id).first<HandoutRow>();
  if (!row) throw responseError("讲义不存在", 404);
  return toHandout(row, await listHandoutCourses(user));
}

// Public systems and topics are shared; private systems are restricted to administrators.
// Reuse position for a chosen lesson number (zero-based); omitted positions append.
export async function createHandout(user: AuthUser, raw: unknown): Promise<Handout> {
  const group = await groupOf(user, raw);
  const studentName = group.studentId ? await ownStudentName(user, group.studentId) : null;
  const position = raw && typeof raw === "object" && "position" in raw ? raw.position : undefined;
  if (position !== undefined && (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0 || position >= Number.MAX_SAFE_INTEGER)) throw responseError("讲次请填写正整数", 400);
  const { title, items, temporaryQuestions, itemsJson } = await encode(raw, user, [], group.studentId);
  const id = crypto.randomUUID(); const now = Date.now();
  // Check and insert together so two teachers cannot create the same lesson number.
  const row = await db().prepare(`INSERT INTO handouts (id, title, items_json, course_unit_id, domain, student_id, position, created_at, updated_at, owner_user_id)
    SELECT ?, ?, ?, ?, ?, ?, COALESCE(?, MAX(position) + 1, 0), ?, ?, ? FROM handouts WHERE course_unit_id IS ? AND domain IS ? AND student_id IS ?
    HAVING ? IS NULL OR COUNT(CASE WHEN position = ? THEN 1 END) = 0
    RETURNING position`).bind(id, title, itemsJson, group.courseUnitId, group.domain, group.studentId, position ?? null, now, now, user.id, group.courseUnitId, group.domain, group.studentId, position ?? null, position ?? null).first<{ position: number }>();
  if (!row) throw responseError(`第${Number(position) + 1}讲已存在，请填写其他讲次`, 409);
  const nodes = await listHandoutCourses(user);
  return { id, title, items, temporaryQuestions, ...group, coursePath: coursePath(nodes, group.courseUnitId ?? group.domain), domainName: nodes.find((node) => node.id === group.domain)?.name ?? null, studentName, position: row.position, createdAt: now, updatedAt: now };
}

export async function updateHandout(user: AuthUser, id: string, raw: unknown): Promise<Handout> {
  const previous = await getHandout(user, id);
  const { title, items, temporaryQuestions, itemsJson } = await encode(raw, user, previous.temporaryQuestions, previous.studentId);
  const now = Date.now();
  const row = await db().prepare(`${VISIBLE_COURSES} UPDATE handouts SET title = ?, items_json = ?, updated_at = ?
    WHERE id = ? AND ${WRITABLE} RETURNING course_unit_id, domain, student_id, position, created_at`).bind(user.role === "admin" ? 1 : 0, title, itemsJson, now, id, user.id)
    .first<Pick<HandoutRow, "course_unit_id" | "domain" | "student_id" | "position" | "created_at">>();
  if (!row) throw responseError("讲义不存在", 404);
  const group = storedGroup(row);
  const studentName = group.studentId ? await ownStudentName(user, group.studentId) : null;
  const nodes = await listHandoutCourses(user);
  return { id, title, items, temporaryQuestions, ...group, coursePath: coursePath(nodes, group.courseUnitId ?? group.domain), domainName: nodes.find((node) => node.id === group.domain)?.name ?? null, studentName, position: row.position, createdAt: row.created_at, updatedAt: now };
}

// Puts the listed handouts into one group in this order: the 课次 of a term, the topics of a domain or a student's handouts.
// Handouts already in the group but not listed keep their positions; content timestamps are untouched.
export async function arrangeHandouts(user: AuthUser, raw: unknown) {
  const source = raw && typeof raw === "object" ? raw as { ids?: unknown } : {};
  const group = await groupOf(user, raw);
  if (group.studentId) await ownStudentName(user, group.studentId);
  const ids = Array.isArray(source.ids) ? [...new Set(source.ids.filter((id): id is string => typeof id === "string" && Boolean(id)))] : [];
  if (!ids.length || ids.length > MAX_ARRANGE) throw responseError("讲义列表无效", 400);
  const current = await db().prepare("SELECT id, position FROM handouts WHERE course_unit_id IS ? AND domain IS ? AND student_id IS ? ORDER BY position, created_at")
    .bind(group.courseUnitId, group.domain, group.studentId).all<{ id: string; position: number }>();
  // Reordering uses the occupied lesson slots; incoming handouts append after the highest one.
  const positions = current.results.filter((item) => ids.includes(item.id)).map((item) => item.position);
  let next = current.results.reduce((max, item) => Math.max(max, item.position + 1), 0);
  // Moving one's student handout to a shared shelf also shares its temporary figures.
  // Do not inspect or grant media for another teacher's invisible student handout.
  if (!group.studentId) {
    const visible = await db().prepare(`${SELECT_VISIBLE} AND handouts.id IN (SELECT value FROM json_each(?))`).bind(user.role === "admin" ? 1 : 0, user.id, JSON.stringify(ids)).all<HandoutRow>();
    for (const row of visible.results) if (row.student_id) for (const question of toHandout(row).temporaryQuestions) await retainQuestionAssetsForUser(question, user);
  }
  const statement = db().prepare(`${VISIBLE_COURSES} UPDATE handouts SET course_unit_id = ?, domain = ?, student_id = ?, position = ? WHERE id = ? AND ${WRITABLE}`);
  await db().batch(ids.map((id, index) => statement.bind(user.role === "admin" ? 1 : 0, group.courseUnitId, group.domain, group.studentId, positions[index] ?? next++, id, user.id)));
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
export async function readCourseLessons(user: AuthUser | null): Promise<CourseLessonDetail[]> {
  if (!(await listHandoutCourses(user)).some((node) => node.id === "course-default")) throw responseError("课程体系不存在", 404);
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

export async function listHandoutCourses(user: AuthUser | null): Promise<HandoutCourseNode[]> {
  const rows = await db().prepare(`${VISIBLE_COURSES} SELECT id, parent_id AS parentId, name, position, is_private AS isPrivate
    FROM handout_course_nodes WHERE id IN (SELECT id FROM visible_courses) ORDER BY position, id`).bind(user?.role === "admin" ? 1 : 0).all<HandoutCourseNode>();
  return rows.results.map((node) => ({ ...node, isPrivate: Boolean(node.isPrivate) }));
}

// Course outlines and topic folders share names, order, permissions and APIs.
export async function saveHandoutCourse(user: AuthUser, raw: unknown) {
  const source = raw && typeof raw === "object" ? raw as { id?: unknown; parentId?: unknown; name?: unknown; direction?: unknown; isPrivate?: unknown } : {};
  // Reject forged visibility changes even on create, rather than silently ignoring them.
  if (source.isPrivate !== undefined) requireAdmin(user);
  const nodes = await listHandoutCourses(user);
  const existing = source.id === undefined ? null : nodes.find((node) => node.id === source.id);
  if (source.id !== undefined && !existing) throw responseError("大纲位置不存在，请刷新后重试", 404);
  if (existing?.id === HANDOUT_TOPIC_ROOT) throw responseError("专题库入口不能修改", 400);
  if (source.isPrivate !== undefined) {
    if (!existing || existing.parentId !== null || typeof source.isPrivate !== "boolean" || source.direction !== undefined || source.name !== undefined) throw responseError("请选择课程体系并使用有效的私密设置", 400);
    await db().prepare("UPDATE handout_course_nodes SET is_private = ? WHERE id = ?").bind(source.isPrivate ? 1 : 0, existing.id).run();
    return { id: existing.id, courseNodes: await listHandoutCourses(user) };
  }
  if (existing && source.direction !== undefined) {
    if (typeof source.direction !== "number" || !Number.isSafeInteger(source.direction) || source.direction === 0) throw responseError("调整方向无效", 400);
    const siblings = nodes.filter((node) => node.parentId === existing.parentId && node.id !== HANDOUT_TOPIC_ROOT);
    const from = siblings.findIndex((node) => node.id === existing.id); const to = from + source.direction;
    if (to >= 0 && to < siblings.length) {
      // A drag can cross several siblings; the menu still sends a one-step offset.
      siblings.splice(to, 0, siblings.splice(from, 1)[0]);
      await db().batch(siblings.map((node, position) => db().prepare("UPDATE handout_course_nodes SET position = ? WHERE id = ?").bind(position, node.id)));
    }
    return { id: existing.id, courseNodes: await listHandoutCourses(user) };
  }
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name || name.length > 80) throw responseError("名称请填写 1 至 80 个字", 400);
  const parentId = existing ? existing.parentId : source.parentId ?? null;
  const parentPath = typeof parentId === "string" ? coursePath(nodes, parentId) : [];
  if (parentId !== null && (!parentPath.length || parentPath.length >= (parentPath[0].id === HANDOUT_TOPIC_ROOT ? 4 : 3))) throw responseError("请选择体系、年级 / 阶段、专题分类或大纲目录", 400);
  if (nodes.some((node) => node.parentId === parentId && node.name === name && node.id !== existing?.id && node.id !== HANDOUT_TOPIC_ROOT)) throw responseError("同一层级已有这个名称", 409);
  const id = existing?.id ?? crypto.randomUUID();
  try {
    if (existing) await db().prepare("UPDATE handout_course_nodes SET name = ? WHERE id = ?").bind(name, id).run();
    else await db().prepare(`INSERT INTO handout_course_nodes (id, parent_id, name, position)
      SELECT ?, ?, ?, COALESCE(MAX(position) + 1, 0) FROM handout_course_nodes WHERE parent_id IS ?`).bind(id, parentId, name, parentId).run();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint/.test(error.message)) throw responseError("同一层级已有这个名称", 409);
    throw error;
  }
  return { id, courseNodes: await listHandoutCourses(user) };
}

export async function deleteHandoutCourse(user: AuthUser, id: unknown) {
  requireAdmin(user);
  if (typeof id !== "string") throw responseError("大纲位置无效", 400);
  if (id === HANDOUT_TOPIC_ROOT) throw responseError("专题库入口不能删除", 400);
  const nodes = await listHandoutCourses(user);
  const paths = nodes.map((node) => coursePath(nodes, node.id))
    .filter((path) => path.some((node) => node.id === id)).sort((a, b) => b.length - a.length);
  if (!paths.length) throw responseError("大纲位置不存在，请刷新后重试", 404);
  const ids = JSON.stringify(paths.map((path) => path[path.length - 1].id));
  // One transaction removes lectures first, then children before parents, respecting RESTRICT foreign keys.
  await db().batch([
    db().prepare(`DELETE FROM handouts WHERE course_unit_id IN (SELECT value FROM json_each(?))
      OR domain IN (SELECT value FROM json_each(?))`).bind(ids, ids),
    ...paths.map((path) => db().prepare("DELETE FROM handout_course_nodes WHERE id = ?").bind(path[path.length - 1].id)),
  ]);
  return { courseNodes: await listHandoutCourses(user) };
}
