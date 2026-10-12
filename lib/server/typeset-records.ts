import { env } from "cloudflare:workers";
import { readRawAsset, storePrivateFile } from "./library";
import type { AuthUser, TypesetRecord } from "../types";

// 快速排版的历史记录：每位老师只读写自己的记录。原始 Word 存进分块素材表，但不授予任何题库读取权限，
// 只能经由本人的记录读取。
type AppEnv = { DB: D1Database };
type RecordRow = { id: string; title: string; file_name: string; question_count: number; settings_json: string; created_at: number; updated_at: number };

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_RECORDS = 300;
const COLUMNS = "id, title, file_name, question_count, settings_json, created_at, updated_at";

function db() {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings.DB;
}

function responseError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

function toRecord(row: RecordRow): TypesetRecord {
  let settings: unknown = {};
  try { settings = JSON.parse(row.settings_json); } catch { /* A damaged row opens with the default settings. */ }
  return {
    id: row.id, title: row.title, fileName: row.file_name, questionCount: row.question_count,
    settings: settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const text = (value: unknown, fallback: string, limit: number) => (typeof value === "string" && value.trim() ? value.trim() : fallback).slice(0, limit);
const count = (value: unknown) => { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.min(10_000, Math.round(number)) : 0; };

function settingsJson(value: unknown) {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw responseError("排版设置无效", 400);
  const json = JSON.stringify(parsed);
  if (new TextEncoder().encode(json).byteLength > MAX_SETTINGS_BYTES) throw responseError("排版设置过大", 413);
  return json;
}

// Newest first: the last edited material is at the top.
export async function listTypesetRecords(user: AuthUser): Promise<TypesetRecord[]> {
  const rows = await db().prepare(`SELECT ${COLUMNS} FROM typeset_records WHERE owner_user_id = ? ORDER BY updated_at DESC LIMIT ?`).bind(user.id, MAX_RECORDS).all<RecordRow>();
  return rows.results.map(toRecord);
}

// The body carries the Word file itself (a base64 data URL, as image uploads do) plus its title, question count and settings.
// A multipart form is not used: the framework reads any multipart POST as a server action and caps it at 1 MB.
export async function createTypesetRecord(user: AuthUser, raw: unknown): Promise<TypesetRecord> {
  const body = raw && typeof raw === "object" ? raw as { fileName?: unknown; file?: unknown; title?: unknown; questionCount?: unknown; settings?: unknown } : {};
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
  await db().prepare(`INSERT INTO typeset_records (id, owner_user_id, title, file_name, question_count, source_asset_id, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, user.id, title, fileName, questionCount, assetId, settings, now, now).run();
  return { id, title, fileName, questionCount, settings: JSON.parse(settings), createdAt: now, updatedAt: now };
}

// Any change of title or settings is an edit: it moves the record to the top of the history.
export async function updateTypesetRecord(user: AuthUser, id: string, raw: unknown): Promise<TypesetRecord> {
  const body = raw && typeof raw === "object" ? raw as { title?: unknown; settings?: unknown } : {};
  const current = await db().prepare(`SELECT ${COLUMNS} FROM typeset_records WHERE id = ? AND owner_user_id = ?`).bind(id, user.id).first<RecordRow>();
  if (!current) throw responseError("这条历史记录不存在", 404);
  const title = body.title === undefined ? current.title : text(body.title, current.title, 200);
  const settings = body.settings === undefined ? current.settings_json : settingsJson(body.settings);
  const now = Date.now();
  await db().prepare("UPDATE typeset_records SET title = ?, settings_json = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?").bind(title, settings, now, id, user.id).run();
  return toRecord({ ...current, title, settings_json: settings, updated_at: now });
}

// The Word file goes with its last record, unless a question or a library still uses the same bytes.
export async function deleteTypesetRecord(user: AuthUser, id: string) {
  const row = await db().prepare("DELETE FROM typeset_records WHERE id = ? AND owner_user_id = ? RETURNING source_asset_id").bind(id, user.id).first<{ source_asset_id: string }>();
  if (!row) throw responseError("这条历史记录不存在", 404);
  const unused = `NOT EXISTS (SELECT 1 FROM typeset_records WHERE source_asset_id = ?1) AND NOT EXISTS (SELECT 1 FROM asset_library_access WHERE asset_id = ?1)`;
  await db().batch([
    db().prepare(`DELETE FROM question_asset_chunks WHERE asset_id = ?1 AND ${unused}`).bind(row.source_asset_id),
    db().prepare(`DELETE FROM question_assets WHERE id = ?1 AND ${unused}`).bind(row.source_asset_id),
  ]);
}

export async function readTypesetSource(user: AuthUser, id: string) {
  const row = await db().prepare("SELECT file_name, source_asset_id FROM typeset_records WHERE id = ? AND owner_user_id = ?").bind(id, user.id).first<{ file_name: string; source_asset_id: string }>();
  if (!row) throw responseError("这条历史记录不存在", 404);
  const asset = await readRawAsset(row.source_asset_id);
  if (!asset) throw responseError("这份 Word 已无法读取", 404);
  return { fileName: row.file_name, bytes: asset.bytes, contentType: asset.contentType };
}
