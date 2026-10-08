import { env } from "cloudflare:workers";
import type { AuthUser, Category, LibraryData, LibraryModule, LibraryScope, Question } from "../../lib/types";
import { retainedQuestionCreatedAt } from "../../lib/question-order-rules.mjs";
import { questionCreationContent } from "../../lib/question-create-rules.mjs";
import { normalizeQuestionProvenance } from "../../lib/exam-modules.mjs";
import { resolveKnowledgeTaxonomyKeys } from "../../lib/homework-capability-framework.mjs";
import { loadPublishedKnowledgeGraph } from "./knowledge-graph";

type AppEnv = { DB: D1Database };

export type LibraryContext = {
  libraryId: string;
  scope: LibraryScope;
  publicationId: string | null;
  ownerUserId: string | null;
  writable: boolean;
  publishedAt: number | null;
};

type StoredAsset = { id: string; content_type: string; byte_size: number; content_hash: string | null };

// 机构版只有一个共用题库：library_id = "public" 的当前版本。
const PUBLIC_LIBRARY_ID = "public";
const PERSONAL_PREFIX = "personal:";
const ASSET_URL = /\/api\/assets\/([0-9a-f-]{36})/gi;

function appEnv(): AppEnv {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings;
}

function versionWhere(publicationId: string | null) {
  return publicationId == null ? "publication_id IS NULL" : "publication_id = ?";
}

function versionBindings(publicationId: string | null) {
  return publicationId == null ? [] : [publicationId];
}

function rowId(context: LibraryContext, kind: "module" | "category" | "question", sourceId: string) {
  return `${context.libraryId}:${context.publicationId ?? "personal"}:${kind}:${sourceId}`;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(bytes: Uint8Array) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function sha256Text(value: string) {
  return sha256Bytes(new TextEncoder().encode(value));
}

function assetIds(value: unknown) {
  const result = new Set<string>();
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const match of text.matchAll(ASSET_URL)) result.add(match[1]);
  return [...result];
}

function normalizedQuestionTags(value: unknown) {
  if (!Array.isArray(value)) return [];
  const result: string[] = []; const seen = new Set<string>();
  for (const item of value) {
    const tag = String(item ?? "").trim().slice(0, 120); const key = tag.toLocaleLowerCase("en");
    if (!tag || seen.has(key)) continue;
    seen.add(key); result.push(tag);
    if (result.length === 30) break;
  }
  return result;
}

function accessKey(libraryId: string, publicationId: string | null, assetId: string) {
  return `${libraryId}|${publicationId ?? "personal"}|${assetId}`;
}

async function grantAssetAccess(assetId: string, context: Pick<LibraryContext, "libraryId" | "publicationId">) {
  await appEnv().DB.prepare(`INSERT OR IGNORE INTO asset_library_access
    (access_key, asset_id, library_id, publication_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(accessKey(context.libraryId, context.publicationId, assetId), assetId, context.libraryId, context.publicationId, Date.now()).run();
}

export async function retainQuestionAssetsForUser(question: Question, user: AuthUser) {
  const context = await resolveLibraryContext(user);
  for (const id of assetIds(question)) await grantAssetAccess(id, context);
}

async function ensureLegacyAssetAccess() {
  const db = appEnv().DB;
  const done = await db.prepare("SELECT value FROM scoped_library_meta WHERE key = 'asset_access_v1'").first<{ value: string }>();
  if (done) return;
  const rows = await db.prepare("SELECT library_id, publication_id, payload_json FROM library_questions_v2").all<Record<string, unknown>>();
  const statements: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const row of rows.results) {
    const libraryId = String(row.library_id);
    const publicationId = row.publication_id == null ? null : String(row.publication_id);
    for (const id of assetIds(String(row.payload_json))) {
      const key = accessKey(libraryId, publicationId, id);
      if (seen.has(key)) continue;
      seen.add(key);
      statements.push(db.prepare(`INSERT OR IGNORE INTO asset_library_access
        (access_key, asset_id, library_id, publication_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(key, id, libraryId, publicationId, Date.now()));
    }
  }
  for (let index = 0; index < statements.length; index += 80) await db.batch(statements.slice(index, index + 80));
  await db.prepare("INSERT OR REPLACE INTO scoped_library_meta (key, value) VALUES ('asset_access_v1', ?)")
    .bind(String(Date.now())).run();
}

// Every teacher reads and writes the one shared library; only deleting needs an administrator.
export async function resolveLibraryContext(user: AuthUser | null): Promise<LibraryContext> {
  const db = appEnv().DB;
  const row = await db.prepare("SELECT active_publication_id, published_at FROM libraries_v2 WHERE id = ?")
    .bind(PUBLIC_LIBRARY_ID).first<{ active_publication_id: string | null; published_at: number | null }>();
  if (!row) throw new Error("公共题库尚未初始化");
  return {
    libraryId: PUBLIC_LIBRARY_ID,
    scope: "public",
    publicationId: row.active_publication_id,
    ownerUserId: null,
    writable: Boolean(user),
    publishedAt: row.published_at,
  };
}

// Students and their wrong books stay with each teacher. Those rows key on the teacher's own
// libraries_v2 entry ("personal:<id>", empty since the libraries merged): existing rows already
// use it, and student_wrong_questions.source_library_id needs it to exist.
export async function teacherNamespaceId(user: AuthUser) {
  const id = `${PERSONAL_PREFIX}${user.id}`;
  await appEnv().DB.prepare(`INSERT OR IGNORE INTO libraries_v2
    (id, kind, owner_user_id, active_publication_id, published_at, created_at)
    VALUES (?, 'personal', ?, NULL, NULL, ?)`)
    .bind(id, user.id, Date.now()).run();
  return id;
}

export function requireWritable(context: LibraryContext) {
  if (!context.writable) {
    throw new Response(JSON.stringify({ error: "请先登录" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
}

export function requireAdmin(user: AuthUser | null) {
  if (user?.role !== "admin") throw new Response(JSON.stringify({ error: "只有管理员可以删除" }), { status: 403, headers: { "Content-Type": "application/json" } });
}

export async function readLibrary(user: AuthUser | null): Promise<LibraryData> {
  await ensureLegacyAssetAccess();
  const context = await resolveLibraryContext(user);
  const db = appEnv().DB;
  const version = versionWhere(context.publicationId);
  const bindings = versionBindings(context.publicationId);
  const [moduleResult, categoryResult, questionResult] = await db.batch([
    db.prepare(`SELECT source_id, name, subtitle, sort_order, created_at, updated_at
      FROM library_modules_v2 WHERE library_id = ? AND ${version}
      ORDER BY sort_order, created_at, source_id`).bind(context.libraryId, ...bindings),
    db.prepare(`SELECT source_id, module_source_id, parent_source_id, name, created_at, created_by
      FROM library_categories_v2 WHERE library_id = ? AND ${version}
      ORDER BY sort_order, created_at, source_id`).bind(context.libraryId, ...bindings),
    db.prepare(`SELECT library_questions_v2.source_id, library_questions_v2.module_source_id,
        library_questions_v2.category_source_id, library_questions_v2.payload_json,
        library_questions_v2.created_by, users.email AS created_by_email
      FROM library_questions_v2 LEFT JOIN users ON users.id = library_questions_v2.created_by
      WHERE library_questions_v2.library_id = ? AND library_questions_v2.${version} AND library_questions_v2.deleted_at IS NULL
      ORDER BY library_questions_v2.created_at DESC`).bind(context.libraryId, ...bindings),
  ]);
  const modules = (moduleResult.results as Array<Record<string, unknown>>).map<LibraryModule>((row) => ({
    id: String(row.source_id), name: String(row.name), subtitle: String(row.subtitle ?? ""),
    sortOrder: Number(row.sort_order), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }));
  const categories = (categoryResult.results as Array<Record<string, unknown>>).map<Category>((row) => ({
    id: String(row.source_id), name: String(row.name), moduleId: String(row.module_source_id),
    parentId: row.parent_source_id == null ? String(row.module_source_id) : String(row.parent_source_id),
    createdAt: Number(row.created_at), createdBy: row.created_by == null ? null : String(row.created_by),
  }));
  const questions = (questionResult.results as Array<Record<string, unknown>>).map<Question>((row) => {
    const question = JSON.parse(String(row.payload_json)) as Question;
    const moduleId = String(row.module_source_id);
    const createdBy = row.created_by == null ? null : String(row.created_by);
    return {
      ...question,
      id: String(row.source_id),
      moduleId,
      categoryId: row.category_source_id == null ? moduleId : String(row.category_source_id),
      createdBy,
      createdByEmail: !user || row.created_by_email == null ? null : String(row.created_by_email),
      canEdit: context.writable,
    };
  });
  return { scope: "public", modules, categories, questions, publishedAt: context.publishedAt };
}

function dataUrlBytes(value: string) {
  const match = value.match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([\s\S]+)$/);
  if (!match) return null;
  const binary = atob(match[2]);
  return { contentType: match[1], bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)) };
}

async function storeAsset(contentType: string, bytes: Uint8Array, context: LibraryContext) {
  const db = appEnv().DB;
  const contentHash = await sha256Bytes(bytes);
  let asset = await db.prepare("SELECT id, content_type, byte_size, content_hash FROM question_assets WHERE content_hash = ?")
    .bind(contentHash).first<StoredAsset>();
  if (!asset) {
    const id = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO question_assets
      (id, content_type, byte_size, created_at, content_hash) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(content_hash) WHERE content_hash IS NOT NULL DO NOTHING`).bind(id, contentType, bytes.byteLength, Date.now(), contentHash)];
    const chunkSize = 500_000;
    for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunkSize, index += 1) {
      const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength));
      statements.push(db.prepare(`INSERT INTO question_asset_chunks (asset_id, chunk_index, data)
        SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM question_assets WHERE id = ?)`)
        .bind(id, index, chunk.buffer, id));
    }
    // The winning uploader commits metadata and all bytes together. Losing
    // concurrent uploads skip their chunks and reuse that complete asset.
    await db.batch(statements);
    asset = await db.prepare("SELECT id, content_type, byte_size, content_hash FROM question_assets WHERE content_hash = ?")
      .bind(contentHash).first<StoredAsset>();
    if (!asset) throw new Error("配图保存结果无法确认，请重试");
  }
  await grantAssetAccess(asset.id, context);
  return `/api/assets/${asset.id}`;
}

async function uploadMediaValue(value: unknown, context: LibraryContext): Promise<unknown> {
  if (typeof value === "string") {
    const decoded = dataUrlBytes(value);
    if (decoded) return storeAsset(decoded.contentType, decoded.bytes, context);
    const match = value.match(/^\/api\/assets\/([0-9a-f-]{36})$/i);
    if (match) await grantAssetAccess(match[1], context);
    return value;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => uploadMediaValue(item, context)));
  if (value && typeof value === "object") {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await uploadMediaValue(item, context)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

export async function prepareQuestion(raw: Question, user: AuthUser, context: LibraryContext, existing?: { createdBy: string | null; createdAt: number }) {
  const now = Date.now();
  const sanitized = { ...raw };
  delete sanitized.canEdit;
  delete sanitized.createdByEmail;
  delete sanitized.createdBy;
  sanitized.tags = normalizedQuestionTags(raw.tags);
  if (Array.isArray(raw.tagsZh)) sanitized.tagsZh = normalizedQuestionTags(raw.tagsZh);
  else delete sanitized.tagsZh;
  if (Array.isArray(raw.tagsEn)) sanitized.tagsEn = normalizedQuestionTags(raw.tagsEn);
  else delete sanitized.tagsEn;
  const mediaSafe = await uploadMediaValue(sanitized, context) as Question;
  const { index: graph } = await loadPublishedKnowledgeGraph();
  return {
    ...mediaSafe,
    id: raw.id || crypto.randomUUID(),
    moduleId: String(raw.moduleId ?? ""),
    stem: String(raw.stem ?? "").trim().slice(0, 100_000),
    categoryId: String(raw.categoryId ?? raw.moduleId ?? ""),
    provenance: normalizeQuestionProvenance(raw.provenance),
    examYear: String(raw.examYear ?? "").trim().slice(0, 40),
    taxonomyKeys: resolveKnowledgeTaxonomyKeys(sanitized.tagsZh?.length ? sanitized.tagsZh : sanitized.tags ?? [], raw.stem, graph),
    createdAt: existing?.createdAt ?? retainedQuestionCreatedAt(raw.createdAt, now),
    updatedAt: now,
    createdBy: existing?.createdBy ?? user.id,
  };
}

async function validateModule(context: LibraryContext, moduleId: string) {
  const version = versionWhere(context.publicationId);
  const row = await appEnv().DB.prepare(`SELECT source_id FROM library_modules_v2
    WHERE library_id = ? AND ${version} AND source_id = ?`)
    .bind(context.libraryId, ...versionBindings(context.publicationId), moduleId).first();
  if (!row) throw new Response(JSON.stringify({ error: "所选模块不存在" }), { status: 400, headers: { "Content-Type": "application/json" } });
}

async function validateCategory(context: LibraryContext, moduleId: string, categoryId: string) {
  if (categoryId === moduleId) return null;
  const version = versionWhere(context.publicationId);
  const row = await appEnv().DB.prepare(`SELECT source_id FROM library_categories_v2
    WHERE library_id = ? AND ${version} AND module_source_id = ? AND source_id = ?`)
    .bind(context.libraryId, ...versionBindings(context.publicationId), moduleId, categoryId).first();
  if (!row) throw new Response(JSON.stringify({ error: "所选分类不存在" }), { status: 400, headers: { "Content-Type": "application/json" } });
  return categoryId;
}

export async function createScopedQuestion(raw: Question, user: AuthUser) {
  const context = await resolveLibraryContext(user); requireWritable(context);
  const moduleId = String(raw.moduleId || raw.categoryId || "");
  await validateModule(context, moduleId);
  const categoryId = await validateCategory(context, moduleId, String(raw.categoryId || moduleId));
  const question = await prepareQuestion({ ...raw, moduleId, categoryId: categoryId ?? moduleId }, user, context);
  const payload = JSON.stringify(question);
  const db = appEnv().DB;
  const result = await db.prepare(`INSERT INTO library_questions_v2
    (row_id, source_id, library_id, publication_id, module_source_id, category_source_id,
     payload_json, content_hash, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(rowId(context, "question", question.id), question.id, context.libraryId, context.publicationId,
      moduleId, categoryId, payload, await sha256Text(payload), user.id, question.createdAt, question.updatedAt).run();
  if (!result.meta.changes) {
    const existing = await db.prepare(`SELECT payload_json FROM library_questions_v2
      WHERE library_id = ? AND ${versionWhere(context.publicationId)} AND source_id = ?`)
      .bind(context.libraryId, ...versionBindings(context.publicationId), question.id).first<{ payload_json: string }>();
    if (!existing) throw new Error("试题保存结果无法确认，请重试");
    const stored = JSON.parse(existing.payload_json) as Question;
    let identical = questionCreationContent(stored) === questionCreationContent(question);
    if (!identical) {
      // Concurrent uploads can give identical image bytes different storage IDs.
      const ids = [...new Set([...assetIds(stored), ...assetIds(question)])];
      const hashes = new Map<string, string>();
      for (let index = 0; index < ids.length; index += 80) {
        const chunk = ids.slice(index, index + 80);
        const assets = await db.prepare(`SELECT id, content_hash FROM question_assets
          WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ id: string; content_hash: string | null }>();
        for (const asset of assets.results) if (asset.content_hash) hashes.set(asset.id, asset.content_hash);
      }
      identical = questionCreationContent(stored, hashes) === questionCreationContent(question, hashes);
    }
    if (!identical) throw new Response(JSON.stringify({ error: "这道题已经保存，但提交内容不同。请刷新题库后编辑已保存的题目。" }), {
      status: 409, headers: { "Content-Type": "application/json" },
    });
    return { ...stored, createdByEmail: user.email, canEdit: true };
  }
  return { ...question, moduleId, categoryId: categoryId ?? moduleId, createdBy: user.id, createdByEmail: user.email, canEdit: true };
}

export async function updateScopedQuestion(id: string, raw: Question, user: AuthUser) {
  const context = await resolveLibraryContext(user); requireWritable(context);
  const version = versionWhere(context.publicationId);
  const existing = await appEnv().DB.prepare(`SELECT created_by, created_at FROM library_questions_v2
    WHERE library_id = ? AND ${version} AND source_id = ? AND deleted_at IS NULL`)
    .bind(context.libraryId, ...versionBindings(context.publicationId), id).first<{ created_by: string | null; created_at: number }>();
  if (!existing) throw new Response(JSON.stringify({ error: "试题不存在" }), { status: 404, headers: { "Content-Type": "application/json" } });
  const moduleId = String(raw.moduleId || raw.categoryId || "");
  await validateModule(context, moduleId);
  const categoryId = await validateCategory(context, moduleId, String(raw.categoryId || moduleId));
  const question = await prepareQuestion({ ...raw, id, moduleId, categoryId: categoryId ?? moduleId }, user, context, { createdBy: existing.created_by, createdAt: existing.created_at });
  const payload = JSON.stringify(question);
  await appEnv().DB.prepare(`UPDATE library_questions_v2 SET module_source_id = ?, category_source_id = ?,
    payload_json = ?, content_hash = ?, updated_at = ? WHERE library_id = ? AND ${version} AND source_id = ?`)
    .bind(moduleId, categoryId, payload, await sha256Text(payload), question.updatedAt,
      context.libraryId, ...versionBindings(context.publicationId), id).run();
  return { ...question, moduleId, categoryId: categoryId ?? moduleId, createdBy: existing.created_by, createdByEmail: user.email, canEdit: true };
}

/** 删除只是移入回收站；删除模块时其中的试题才会被彻底删除。 */
export async function deleteScopedQuestion(id: string, user: AuthUser) {
  requireAdmin(user);
  const context = await resolveLibraryContext(user); requireWritable(context);
  const version = versionWhere(context.publicationId);
  const result = await appEnv().DB.prepare(`UPDATE library_questions_v2 SET deleted_at = ?
    WHERE library_id = ? AND ${version} AND source_id = ? AND deleted_at IS NULL`)
    .bind(Date.now(), context.libraryId, ...versionBindings(context.publicationId), id).run();
  if (!result.meta.changes) throw new Response(JSON.stringify({ error: "试题不存在" }), { status: 404, headers: { "Content-Type": "application/json" } });
}

export async function readDeletedQuestions(user: AuthUser) {
  requireAdmin(user);
  const context = await resolveLibraryContext(user); requireWritable(context);
  const rows = await appEnv().DB.prepare(`SELECT source_id, module_source_id, category_source_id, payload_json, deleted_at
    FROM library_questions_v2 WHERE library_id = ? AND ${versionWhere(context.publicationId)} AND deleted_at IS NOT NULL
    ORDER BY deleted_at DESC`).bind(context.libraryId, ...versionBindings(context.publicationId)).all<Record<string, unknown>>();
  return rows.results.map((row: Record<string, unknown>) => {
    const moduleId = String(row.module_source_id);
    return { ...JSON.parse(String(row.payload_json)) as Question, id: String(row.source_id), moduleId,
      categoryId: row.category_source_id == null ? moduleId : String(row.category_source_id), deletedAt: Number(row.deleted_at) };
  });
}

/** 恢复到原分类；原分类已被删除时回到模块根目录。 */
export async function restoreScopedQuestion(id: string, user: AuthUser) {
  requireAdmin(user);
  const context = await resolveLibraryContext(user); requireWritable(context);
  const version = versionWhere(context.publicationId); const bindings = versionBindings(context.publicationId);
  const result = await appEnv().DB.prepare(`UPDATE library_questions_v2 SET deleted_at = NULL,
      category_source_id = CASE WHEN EXISTS (SELECT 1 FROM library_categories_v2 AS categories WHERE categories.library_id = library_questions_v2.library_id
        AND categories.${version} AND categories.source_id = library_questions_v2.category_source_id) THEN category_source_id ELSE NULL END
    WHERE library_id = ? AND ${version} AND source_id = ? AND deleted_at IS NOT NULL`)
    .bind(...bindings, context.libraryId, ...bindings, id).run();
  if (!result.meta.changes) throw new Response(JSON.stringify({ error: "回收站中没有这道试题" }), { status: 404, headers: { "Content-Type": "application/json" } });
}

export async function createScopedCategory(raw: Category, user: AuthUser) {
  const context = await resolveLibraryContext(user); requireWritable(context);
  const name = String(raw.name ?? "").trim().slice(0, 100);
  const moduleId = String(raw.moduleId || raw.parentId || "");
  if (!name) throw new Response(JSON.stringify({ error: "请填写分类名称" }), { status: 400, headers: { "Content-Type": "application/json" } });
  await validateModule(context, moduleId);
  const parentId = !raw.parentId || raw.parentId === moduleId ? moduleId : String(raw.parentId);
  if (parentId !== moduleId) await validateCategory(context, moduleId, parentId);
  const category: Category = { id: raw.id || crypto.randomUUID(), name, moduleId, parentId, createdAt: Date.now(), createdBy: user.id };
  const version = versionWhere(context.publicationId);
  const count = await appEnv().DB.prepare(`SELECT COUNT(*) AS count FROM library_categories_v2
    WHERE library_id = ? AND ${version} AND module_source_id = ?`)
    .bind(context.libraryId, ...versionBindings(context.publicationId), moduleId).first<{ count: number }>();
  const content = JSON.stringify({ name, moduleId, parentId });
  await appEnv().DB.prepare(`INSERT INTO library_categories_v2
    (row_id, source_id, library_id, publication_id, module_source_id, parent_source_id,
     name, sort_order, content_hash, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(rowId(context, "category", category.id), category.id, context.libraryId, context.publicationId,
      moduleId, parentId, name, Number(count?.count ?? 0), await sha256Text(content), user.id, category.createdAt).run();
  return category;
}

export async function deleteScopedCategory(id: string, user: AuthUser) {
  requireAdmin(user);
  const context = await resolveLibraryContext(user); requireWritable(context);
  const data = await readLibrary(user);
  const category = data.categories.find((item) => item.id === id);
  if (!category) throw new Response(JSON.stringify({ error: "分类不存在" }), { status: 404, headers: { "Content-Type": "application/json" } });
  const ids = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of data.categories) if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) { ids.add(item.id); changed = true; }
  }
  const version = versionWhere(context.publicationId);
  const idList = [...ids];
  const placeholders = idList.map(() => "?").join(",");
  await appEnv().DB.batch([
    appEnv().DB.prepare(`UPDATE library_questions_v2 SET deleted_at = ? WHERE library_id = ? AND ${version}
      AND category_source_id IN (${placeholders}) AND deleted_at IS NULL`).bind(Date.now(), context.libraryId, ...versionBindings(context.publicationId), ...idList),
    appEnv().DB.prepare(`DELETE FROM library_categories_v2 WHERE library_id = ? AND ${version}
      AND source_id IN (${placeholders})`).bind(context.libraryId, ...versionBindings(context.publicationId), ...idList),
  ]);
  return { categoryIds: idList };
}

export async function createScopedModule(raw: Partial<LibraryModule>, user: AuthUser) {
  const context = await resolveLibraryContext(user); requireWritable(context);
  const name = String(raw.name ?? "").trim().slice(0, 100);
  const subtitle = String(raw.subtitle ?? "").trim().slice(0, 160);
  if (!name) throw new Response(JSON.stringify({ error: "请填写模块名称" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const version = versionWhere(context.publicationId);
  const count = await appEnv().DB.prepare(`SELECT COUNT(*) AS count FROM library_modules_v2
    WHERE library_id = ? AND ${version}`).bind(context.libraryId, ...versionBindings(context.publicationId)).first<{ count: number }>();
  const now = Date.now();
  const createdModule: LibraryModule = { id: raw.id || crypto.randomUUID(), name, subtitle, sortOrder: Number(count?.count ?? 0), createdAt: now, updatedAt: now };
  const content = JSON.stringify({ name, subtitle, sortOrder: createdModule.sortOrder });
  await appEnv().DB.prepare(`INSERT INTO library_modules_v2
    (row_id, source_id, library_id, publication_id, name, subtitle, sort_order,
     content_hash, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(rowId(context, "module", createdModule.id), createdModule.id, context.libraryId, context.publicationId,
      name, subtitle, createdModule.sortOrder, await sha256Text(content), user.id, now, now).run();
  return createdModule;
}

export async function updateScopedModule(id: string, raw: Partial<LibraryModule>, user: AuthUser) {
  const context = await resolveLibraryContext(user); requireWritable(context);
  const name = String(raw.name ?? "").trim().slice(0, 100);
  const subtitle = String(raw.subtitle ?? "").trim().slice(0, 160);
  if (!name) throw new Response(JSON.stringify({ error: "请填写模块名称" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const version = versionWhere(context.publicationId); const now = Date.now();
  const existing = await appEnv().DB.prepare(`SELECT sort_order, created_at FROM library_modules_v2
    WHERE library_id = ? AND ${version} AND source_id = ?`)
    .bind(context.libraryId, ...versionBindings(context.publicationId), id).first<{ sort_order: number; created_at: number }>();
  if (!existing) throw new Response(JSON.stringify({ error: "模块不存在" }), { status: 404, headers: { "Content-Type": "application/json" } });
  const content = JSON.stringify({ name, subtitle, sortOrder: existing.sort_order });
  await appEnv().DB.prepare(`UPDATE library_modules_v2 SET name = ?, subtitle = ?, content_hash = ?, updated_at = ?
    WHERE library_id = ? AND ${version} AND source_id = ?`)
    .bind(name, subtitle, await sha256Text(content), now, context.libraryId, ...versionBindings(context.publicationId), id).run();
  return { id, name, subtitle, sortOrder: existing.sort_order, createdAt: existing.created_at, updatedAt: now } satisfies LibraryModule;
}

export async function reorderScopedModules(ids: string[], user: AuthUser) {
  const context = await resolveLibraryContext(user); requireWritable(context);
  const data = await readLibrary(user);
  if (ids.length !== data.modules.length || new Set(ids).size !== ids.length || ids.some((id) => !data.modules.some((item) => item.id === id))) {
    throw new Response(JSON.stringify({ error: "模块排序数据不完整" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const version = versionWhere(context.publicationId);
  const statements = ids.map((id, index) => appEnv().DB.prepare(`UPDATE library_modules_v2 SET sort_order = ?, updated_at = ?
    WHERE library_id = ? AND ${version} AND source_id = ?`)
    .bind(index, Date.now(), context.libraryId, ...versionBindings(context.publicationId), id));
  if (statements.length) await appEnv().DB.batch(statements);
}

export async function deleteScopedModule(id: string, confirmation: string, user: AuthUser) {
  requireAdmin(user);
  const context = await resolveLibraryContext(user); requireWritable(context);
  const data = await readLibrary(user);
  const targetModule = data.modules.find((item) => item.id === id);
  if (!targetModule) throw new Response(JSON.stringify({ error: "模块不存在" }), { status: 404, headers: { "Content-Type": "application/json" } });
  if (confirmation !== targetModule.name) throw new Response(JSON.stringify({ error: "请输入完整模块名称确认删除" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const version = versionWhere(context.publicationId);
  const questionCount = data.questions.filter((item) => item.moduleId === id).length;
  const categoryCount = data.categories.filter((item) => item.moduleId === id).length;
  await appEnv().DB.batch([
    appEnv().DB.prepare(`DELETE FROM library_questions_v2 WHERE library_id = ? AND ${version} AND module_source_id = ?`)
      .bind(context.libraryId, ...versionBindings(context.publicationId), id),
    appEnv().DB.prepare(`DELETE FROM library_categories_v2 WHERE library_id = ? AND ${version} AND module_source_id = ?`)
      .bind(context.libraryId, ...versionBindings(context.publicationId), id),
    appEnv().DB.prepare(`DELETE FROM library_modules_v2 WHERE library_id = ? AND ${version} AND source_id = ?`)
      .bind(context.libraryId, ...versionBindings(context.publicationId), id),
  ]);
  const remaining = data.modules.filter((item) => item.id !== id).sort((left, right) => left.sortOrder - right.sortOrder);
  if (remaining.length) {
    const now = Date.now();
    await appEnv().DB.batch(remaining.map((item, index) => appEnv().DB.prepare(`UPDATE library_modules_v2 SET sort_order = ?, updated_at = ?
      WHERE library_id = ? AND ${version} AND source_id = ?`)
      .bind(index, now, context.libraryId, ...versionBindings(context.publicationId), item.id)));
  }
  return { questionCount, categoryCount };
}

export async function readRawAsset(id: string) {
  const db = appEnv().DB;
  const metadata = await db.prepare("SELECT content_type, byte_size, content_hash FROM question_assets WHERE id = ?")
    .bind(id).first<{ content_type: string; byte_size: number; content_hash: string | null }>();
  if (!metadata) return null;
  const result = await db.prepare("SELECT data FROM question_asset_chunks WHERE asset_id = ? ORDER BY chunk_index ASC")
    .bind(id).all<{ data: ArrayBuffer | number[] }>();
  const output = new Uint8Array(metadata.byte_size); let offset = 0;
  for (const row of result.results) {
    const chunk = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : Uint8Array.from(row.data);
    output.set(chunk, offset); offset += chunk.byteLength;
  }
  return { id, bytes: output, contentType: metadata.content_type, contentHash: metadata.content_hash ?? await sha256Bytes(output) };
}

export async function readAssetForUser(id: string, user: AuthUser | null) {
  await ensureLegacyAssetAccess();
  const asset = await readRawAsset(id); if (!asset) return null;
  const db = appEnv().DB;
  const publicRow = await db.prepare(`SELECT 1 FROM asset_library_access access
    JOIN libraries_v2 library ON library.id = access.library_id
    WHERE access.asset_id = ? AND access.library_id = 'public'
      AND access.publication_id = library.active_publication_id LIMIT 1`).bind(id).first();
  if (publicRow) return { ...asset, public: true };
  if (!user) return null;
  const personalRow = await db.prepare(`SELECT 1 FROM asset_library_access access
    JOIN libraries_v2 library ON library.id = access.library_id
    WHERE access.asset_id = ? AND library.owner_user_id = ? LIMIT 1`).bind(id, user.id).first();
  return personalRow ? { ...asset, public: false } : null;
}

export async function authorizeQuestionDownload(user: AuthUser, questionIds: string[]) {
  const data = await readLibrary(user);
  const available = new Set(data.questions.map((item) => item.id));
  // 学生错题本里的题目是快照、不在题库中；属于本人学生档案的同样可以组卷导出。
  const outside = questionIds.filter((id) => !available.has(id));
  if (outside.length) {
    const owned = await appEnv().DB.prepare(`SELECT DISTINCT json_extract(question_snapshot_json, '$.id') AS id FROM student_wrong_questions
      WHERE owner_user_id = ? AND json_extract(question_snapshot_json, '$.id') IN (SELECT value FROM json_each(?))`)
      .bind(user.id, JSON.stringify(outside)).all<{ id: string }>();
    for (const row of owned.results) available.add(String(row.id));
  }
  return questionIds.length > 0 && questionIds.every((id) => available.has(id));
}

// 讲义说明里的配图：存进共用题库的素材，读取权限与题目配图相同。
const NOTE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export async function storeUserImage(dataUrl: string, user: AuthUser) {
  const decoded = dataUrlBytes(dataUrl);
  if (!decoded || !NOTE_IMAGE_TYPES.has(decoded.contentType)) throw new Response(JSON.stringify({ error: "只能上传 PNG、JPEG、WebP 或 GIF 图片" }), { status: 400, headers: { "Content-Type": "application/json" } });
  if (decoded.bytes.byteLength > 8 * 1024 * 1024) throw new Response(JSON.stringify({ error: "图片超过 8MB，请裁剪后重试" }), { status: 413, headers: { "Content-Type": "application/json" } });
  return storeAsset(decoded.contentType, decoded.bytes, await resolveLibraryContext(user));
}

export function libraryBindings() { return appEnv(); }
export function libraryConstants() { return { PUBLIC_LIBRARY_ID }; }
export function encodeAssetBase64(bytes: Uint8Array) { return bytesToBase64(bytes); }
export async function hashBytes(bytes: Uint8Array) { return sha256Bytes(bytes); }
export async function hashText(value: string) { return sha256Text(value); }
