import { env } from "cloudflare:workers";
import { handoutOutline, normalizeHandoutDraft, normalizeHandoutGroup, sheetCounts } from "../handout-rules.mjs";
import { requireAdmin } from "./library";
import type { AuthUser, Handout, HandoutGroup, HandoutSummary } from "../types";

type AppEnv = { DB: D1Database };
type HandoutRow = { id: string; title: string; items_json: string; grade: number | null; term: string | null; domain: string | null; student_id: string | null; student_name: string | null; position: number; created_at: number; updated_at: number };

// D1 caps a single row at 2 MB. Handouts hold only references, so this is a guard, not a budget.
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
  let items: unknown = [];
  try { items = JSON.parse(row.items_json); } catch { /* A damaged row opens as an empty handout instead of failing the list. */ }
  const group = storedGroup(row);
  return {
    id: row.id, title: row.title, items: normalizeHandoutDraft({ title: row.title, items }).items, ...group,
    studentName: group.studentId ? row.student_name : null, position: row.position, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function encode(raw: unknown) {
  const draft = normalizeHandoutDraft(raw);
  const itemsJson = JSON.stringify(draft.items);
  if (new TextEncoder().encode(itemsJson).byteLength > MAX_ITEMS_BYTES) throw responseError("讲义内容过多，请拆成两份", 413);
  return { ...draft, itemsJson };
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
    const { items, ...summary } = toHandout(row);
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
  const { title, items, itemsJson } = encode(raw);
  const group = groupOf(raw);
  const studentName = group.studentId ? await ownStudentName(user, group.studentId) : null;
  const id = crypto.randomUUID(); const now = Date.now();
  const row = await db().prepare(`INSERT INTO handouts (id, title, items_json, grade, term, domain, student_id, position, created_at, updated_at, owner_user_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, ? FROM handouts WHERE grade IS ? AND term IS ? AND domain IS ? AND student_id IS ?
    RETURNING position`).bind(id, title, itemsJson, group.grade, group.term, group.domain, group.studentId, now, now, user.id, group.grade, group.term, group.domain, group.studentId).first<{ position: number }>();
  return { id, title, items, ...group, studentName, position: row?.position ?? 0, createdAt: now, updatedAt: now };
}

export async function updateHandout(user: AuthUser, id: string, raw: unknown): Promise<Handout> {
  const { title, items, itemsJson } = encode(raw);
  const now = Date.now();
  const row = await db().prepare(`UPDATE handouts SET title = ?, items_json = ?, updated_at = ?
    WHERE id = ? AND ${WRITABLE} RETURNING grade, term, domain, student_id, position, created_at`).bind(title, itemsJson, now, id, user.id)
    .first<Pick<HandoutRow, "grade" | "term" | "domain" | "student_id" | "position" | "created_at">>();
  if (!row) throw responseError("讲义不存在", 404);
  const group = storedGroup(row);
  const studentName = group.studentId ? await ownStudentName(user, group.studentId) : null;
  return { id, title, items, ...group, studentName, position: row.position, createdAt: row.created_at, updatedAt: now };
}

// Puts the listed handouts into one group in this order: the 课次 of a term, the topics of a domain or a student's handouts.
// Handouts already in the group but not listed keep their positions; content timestamps are untouched.
export async function arrangeHandouts(user: AuthUser, raw: unknown) {
  const source = raw && typeof raw === "object" ? raw as { ids?: unknown } : {};
  const group = groupOf(raw);
  if (group.studentId) await ownStudentName(user, group.studentId);
  const ids = Array.isArray(source.ids) ? [...new Set(source.ids.filter((id): id is string => typeof id === "string" && Boolean(id)))] : [];
  if (!ids.length || ids.length > MAX_ARRANGE) throw responseError("讲义列表无效", 400);
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
