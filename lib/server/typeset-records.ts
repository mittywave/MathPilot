import { env } from "cloudflare:workers";
import { readRawAsset, storePrivateFile } from "./library";
import { normalizeSmartPaperPlan, planQuestionIds } from "../smart-paper-contract";
import type { AuthUser, SmartPaperPlan, TypesetRecord } from "../types";

// 快速排版的历史记录：每位老师只读写自己的记录。Word 记录的原始 Word 存进分块素材表，但不授予任何题库读取权限，
// 只能经由本人的记录读取。智能组卷的记录不挂 Word，存的是按天分好的题库题目清单（plan_json）和为谁出的题（student_id）。
type AppEnv = { DB: D1Database };
type RecordRow = {
  id: string; title: string; file_name: string; question_count: number; settings_json: string; created_at: number; updated_at: number;
  source_kind: "word" | "library"; plan_json: string; student_id: string | null; student_name: string | null; assigned_to_json: string;
};

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_RECORDS = 300;
const SELECT = `SELECT r.id, r.title, r.file_name, r.question_count, r.settings_json, r.created_at, r.updated_at,
  r.source_kind, r.plan_json, r.student_id, s.name AS student_name,
  (SELECT json_group_array(json_object('id', recipient.id, 'name', recipient.name, 'className', recipient.class_name)) FROM (
    SELECT DISTINCT student.id, student.name, student.class_name
    FROM homework_assignments a JOIN homework_submissions submission ON submission.assignment_id = a.id
    JOIN students student ON student.id = submission.student_id AND student.owner_user_id = r.owner_user_id
    WHERE a.owner_user_id = r.owner_user_id AND a.status <> 'archived'
      AND json_extract(CASE WHEN json_valid(a.sheet_json) THEN a.sheet_json ELSE '{}' END, '$.recordId') = r.id
    ORDER BY student.class_name, student.name, student.id
  ) recipient) AS assigned_to_json
  FROM typeset_records r LEFT JOIN students s ON s.id = r.student_id`;

function db() {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings.DB;
}

function responseError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

const parsed = (json: string) => { try { return JSON.parse(json) as unknown; } catch { return null; } };

function toRecord(row: RecordRow): TypesetRecord {
  const settings = parsed(row.settings_json);
  return {
    id: row.id, title: row.title, fileName: row.file_name, questionCount: row.question_count,
    // A damaged row opens with the default settings.
    settings: settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}, createdAt: row.created_at, updatedAt: row.updated_at,
    sourceKind: row.source_kind, studentId: row.student_id, studentName: row.student_name,
    plan: row.source_kind === "library" ? normalizeSmartPaperPlan(parsed(row.plan_json)) : null,
    assignedTo: JSON.parse(row.assigned_to_json),
  };
}

const text = (value: unknown, fallback: string, limit: number) => (typeof value === "string" && value.trim() ? value.trim() : fallback).slice(0, limit);
const count = (value: unknown) => { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.min(10_000, Math.round(number)) : 0; };

function settingsJson(value: unknown) {
  const raw = typeof value === "string" ? parsed(value) : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw responseError("排版设置无效", 400);
  const json = JSON.stringify(raw);
  if (new TextEncoder().encode(json).byteLength > MAX_SETTINGS_BYTES) throw responseError("排版设置过大", 413);
  return json;
}

function planOf(value: unknown): SmartPaperPlan {
  const plan = normalizeSmartPaperPlan(typeof value === "string" ? parsed(value) : value);
  if (!plan) throw responseError("方案里没有题目", 400);
  if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > MAX_PLAN_BYTES) throw responseError("方案过大", 413);
  return plan;
}

// A plan may only name one of the teacher's own students.
async function ownStudentId(user: AuthUser, studentId: string | null) {
  if (!studentId) return null;
  const row = await db().prepare("SELECT id FROM students WHERE id = ? AND owner_user_id = ?").bind(studentId, user.id).first<{ id: string }>();
  if (!row) throw responseError("学生不存在", 404);
  return row.id;
}

async function readRecord(user: AuthUser, id: string) {
  const row = await db().prepare(`${SELECT} WHERE r.id = ? AND r.owner_user_id = ?`).bind(id, user.id).first<RecordRow>();
  if (!row) throw responseError("这条历史记录不存在", 404);
  return row;
}

// Newest first: the last edited material is at the top.
export async function listTypesetRecords(user: AuthUser): Promise<TypesetRecord[]> {
  const rows = await db().prepare(`${SELECT} WHERE r.owner_user_id = ? ORDER BY r.updated_at DESC LIMIT ?`).bind(user.id, MAX_RECORDS).all<RecordRow>();
  return rows.results.map(toRecord);
}

// A Word body carries the file itself (a base64 data URL, as image uploads do) plus its title, question count and settings.
// A multipart form is not used: the framework reads any multipart POST as a server action and caps it at 1 MB.
// A 智能组卷 body carries its plan instead of a file.
export async function createTypesetRecord(user: AuthUser, raw: unknown): Promise<TypesetRecord> {
  const body = raw && typeof raw === "object" ? raw as { fileName?: unknown; file?: unknown; title?: unknown; questionCount?: unknown; settings?: unknown; plan?: unknown } : {};
  if (body.plan !== undefined) return createLibraryRecord(user, body);
  const encoded = typeof body.file === "string" ? body.file.match(/^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/)?.[1] : undefined;
  if (typeof body.fileName !== "string" || !/\.docx$/i.test(body.fileName) || !encoded) throw responseError("没有收到 Word（.docx）文件", 400);
  if (encoded.length * 3 / 4 > MAX_SOURCE_BYTES) throw responseError("Word 文件超过 30MB，未保存到历史记录", 413);
  const settings = settingsJson(body.settings);
  const binary = atob(encoded); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const assetId = await storePrivateFile(DOCX, bytes);
  const id = crypto.randomUUID(); const now = Date.now();
  const fileName = text(body.fileName, "练习.docx", 200);
  const title = text(body.title, fileName.replace(/\.docx$/i, ""), 200);
  const questionCount = count(body.questionCount);
  await db().prepare(`INSERT INTO typeset_records (id, owner_user_id, title, file_name, question_count, source_kind, source_asset_id, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'word', ?, ?, ?, ?)`).bind(id, user.id, title, fileName, questionCount, assetId, settings, now, now).run();
  return { id, title, fileName, questionCount, settings: JSON.parse(settings), createdAt: now, updatedAt: now, sourceKind: "word", studentId: null, studentName: null, plan: null, assignedTo: [] };
}

async function createLibraryRecord(user: AuthUser, body: { title?: unknown; settings?: unknown; plan?: unknown }) {
  const plan = planOf(body.plan);
  const studentId = await ownStudentId(user, plan.studentId);
  const settings = settingsJson(body.settings ?? {});
  const id = crypto.randomUUID(); const now = Date.now();
  const title = text(body.title, plan.brief.title || "智能组卷", 200);
  await db().prepare(`INSERT INTO typeset_records (id, owner_user_id, title, file_name, question_count, source_kind, source_asset_id, plan_json, student_id, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, '', ?, 'library', NULL, ?, ?, ?, ?, ?)`).bind(id, user.id, title, planQuestionIds(plan).length, JSON.stringify(plan), studentId, settings, now, now).run();
  return toRecord(await readRecord(user, id));
}

// Any change of title, settings or (智能组卷) plan is an edit: it moves the record to the top of the history.
export async function updateTypesetRecord(user: AuthUser, id: string, raw: unknown): Promise<TypesetRecord> {
  const body = raw && typeof raw === "object" ? raw as { title?: unknown; settings?: unknown; plan?: unknown } : {};
  const current = await readRecord(user, id);
  if (body.plan !== undefined && current.source_kind !== "library") throw responseError("Word 记录没有题目清单", 400);
  const title = body.title === undefined ? current.title : text(body.title, current.title, 200);
  const settings = body.settings === undefined ? current.settings_json : settingsJson(body.settings);
  const plan = body.plan === undefined ? null : planOf(body.plan);
  const studentId = plan ? await ownStudentId(user, plan.studentId) : current.student_id;
  const planJson = plan ? JSON.stringify(plan) : current.plan_json;
  const questionCount = plan ? planQuestionIds(plan).length : current.question_count;
  const now = Date.now();
  await db().prepare(`UPDATE typeset_records SET title = ?, settings_json = ?, plan_json = ?, question_count = ?, student_id = ?, updated_at = ?
    WHERE id = ? AND owner_user_id = ?`).bind(title, settings, planJson, questionCount, studentId, now, id, user.id).run();
  return toRecord(await readRecord(user, id));
}

// The Word file goes with its last record, unless a question or a library still uses the same bytes. A 智能组卷 record holds no file.
export async function deleteTypesetRecord(user: AuthUser, id: string) {
  const row = await db().prepare("DELETE FROM typeset_records WHERE id = ? AND owner_user_id = ? RETURNING source_asset_id").bind(id, user.id).first<{ source_asset_id: string | null }>();
  if (!row) throw responseError("这条历史记录不存在", 404);
  if (!row.source_asset_id) return;
  const unused = `NOT EXISTS (SELECT 1 FROM typeset_records WHERE source_asset_id = ?1) AND NOT EXISTS (SELECT 1 FROM asset_library_access WHERE asset_id = ?1)`;
  await db().batch([
    db().prepare(`DELETE FROM question_asset_chunks WHERE asset_id = ?1 AND ${unused}`).bind(row.source_asset_id),
    db().prepare(`DELETE FROM question_assets WHERE id = ?1 AND ${unused}`).bind(row.source_asset_id),
  ]);
}

export async function readTypesetSource(user: AuthUser, id: string) {
  const row = await db().prepare("SELECT file_name, source_asset_id FROM typeset_records WHERE id = ? AND owner_user_id = ?").bind(id, user.id).first<{ file_name: string; source_asset_id: string | null }>();
  if (!row) throw responseError("这条历史记录不存在", 404);
  if (!row.source_asset_id) throw responseError("这条记录来自智能组卷，没有原始 Word", 404);
  const asset = await readRawAsset(row.source_asset_id);
  if (!asset) throw responseError("这份 Word 已无法读取", 404);
  return { fileName: row.file_name, bytes: asset.bytes, contentType: asset.contentType };
}

// Every question this teacher has already given this student through 智能组卷, so a new plan can leave them out.
export async function usedQuestionIds(user: AuthUser, studentId: string) {
  const rows = await db().prepare("SELECT plan_json FROM typeset_records WHERE owner_user_id = ? AND student_id = ? AND source_kind = 'library'")
    .bind(user.id, studentId).all<{ plan_json: string }>();
  const used = new Set<string>();
  for (const row of rows.results) {
    const plan = normalizeSmartPaperPlan(parsed(row.plan_json));
    if (plan) for (const id of planQuestionIds(plan)) used.add(id);
  }
  return used;
}
