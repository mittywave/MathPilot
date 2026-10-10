import { env } from "cloudflare:workers";
import { normalizeHandoutDraft, normalizePlacement } from "../handout-rules.mjs";
import { requireAdmin } from "./library";
import type { AuthUser, Handout, HandoutGrade, HandoutSummary, HandoutTerm } from "../types";

type AppEnv = { DB: D1Database };
type HandoutRow = { id: string; title: string; items_json: string; grade: number | null; term: string | null; position: number; created_at: number; updated_at: number };

// D1 caps a single row at 2 MB. Handouts hold only references, so this is a guard, not a budget.
const MAX_ITEMS_BYTES = 1_900_000;
const COLUMNS = "id, title, items_json, grade, term, position, created_at, updated_at";
// One term never holds anywhere near this many 课次; it bounds a single arrange call.
const MAX_ARRANGE = 200;

function db() {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings.DB;
}

function responseError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

function toHandout(row: HandoutRow): Handout {
  let items: unknown = [];
  try { items = JSON.parse(row.items_json); } catch { /* A damaged row opens as an empty handout instead of failing the list. */ }
  const placement = normalizePlacement(row);
  return {
    id: row.id, title: row.title, items: normalizeHandoutDraft({ title: row.title, items }).items,
    grade: placement?.grade ?? null, term: placement?.term ?? null, position: row.position,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function encode(raw: unknown) {
  const draft = normalizeHandoutDraft(raw);
  const itemsJson = JSON.stringify(draft.items);
  if (new TextEncoder().encode(itemsJson).byteLength > MAX_ITEMS_BYTES) throw responseError("讲义内容过多，请拆成两份", 413);
  return { ...draft, itemsJson };
}

export async function listHandouts(): Promise<HandoutSummary[]> {
  const rows = await db().prepare(`SELECT ${COLUMNS} FROM handouts ORDER BY position, created_at`).all<HandoutRow>();
  return rows.results.map((row) => {
    const { items, ...summary } = toHandout(row);
    return { ...summary, questionCount: items.filter((item) => item.kind === "question").length };
  });
}

export async function getHandout(id: string): Promise<Handout> {
  const row = await db().prepare(`SELECT ${COLUMNS} FROM handouts WHERE id = ?`).bind(id).first<HandoutRow>();
  if (!row) throw responseError("讲义不存在", 404);
  return toHandout(row);
}

// 讲义全员共用：任何登录老师都能查看和编辑，owner_user_id 只记录创建人；删除需要管理员。
// A new handout in a term becomes its last 课次.
export async function createHandout(user: AuthUser, raw: unknown): Promise<Handout> {
  const { title, items, itemsJson } = encode(raw);
  const placement = normalizePlacement(raw);
  const id = crypto.randomUUID(); const now = Date.now();
  const row = await db().prepare(`INSERT INTO handouts (${COLUMNS}, owner_user_id)
    SELECT ?, ?, ?, ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, ? FROM handouts WHERE grade IS ? AND term IS ?
    RETURNING position`).bind(id, title, itemsJson, placement?.grade ?? null, placement?.term ?? null, now, now, user.id, placement?.grade ?? null, placement?.term ?? null).first<{ position: number }>();
  return { id, title, items, grade: placement?.grade ?? null, term: placement?.term ?? null, position: row?.position ?? 0, createdAt: now, updatedAt: now };
}

export async function updateHandout(id: string, raw: unknown): Promise<Handout> {
  const { title, items, itemsJson } = encode(raw);
  const now = Date.now();
  const row = await db().prepare(`UPDATE handouts SET title = ?, items_json = ?, updated_at = ?
    WHERE id = ? RETURNING grade, term, position, created_at`).bind(title, itemsJson, now, id).first<Pick<HandoutRow, "grade" | "term" | "position" | "created_at">>();
  if (!row) throw responseError("讲义不存在", 404);
  const placement = normalizePlacement(row);
  return { id, title, items, grade: placement?.grade ?? null, term: placement?.term ?? null, position: row.position, createdAt: row.created_at, updatedAt: now };
}

// Sets one term's 课次 order: the listed handouts move into the term in this order.
// Handouts already in the term but not listed keep their positions; content timestamps are untouched.
export async function arrangeHandouts(raw: unknown) {
  const source = raw && typeof raw === "object" ? raw as { ids?: unknown } : {};
  const placement = normalizePlacement(raw);
  if (!placement) throw responseError("请选择年级和学期", 400);
  const ids = Array.isArray(source.ids) ? [...new Set(source.ids.filter((id): id is string => typeof id === "string" && Boolean(id)))] : [];
  if (!ids.length || ids.length > MAX_ARRANGE) throw responseError("课次列表无效", 400);
  const statement = db().prepare("UPDATE handouts SET grade = ?, term = ?, position = ? WHERE id = ?");
  await db().batch(ids.map((id, position) => statement.bind(placement.grade, placement.term, position, id)));
  return { grade: placement.grade as HandoutGrade, term: placement.term as HandoutTerm, ids };
}

export async function deleteHandout(user: AuthUser, id: string) {
  requireAdmin(user);
  const result = await db().prepare("DELETE FROM handouts WHERE id = ?").bind(id).run();
  if (!result.meta.changes) throw responseError("讲义不存在", 404);
}
