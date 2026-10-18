import { env } from "cloudflare:workers";
import type { AuthUser, Category, LibraryModule, Question } from "../../lib/types";
import { deduplicatePublicationAssets } from "../publication-assets.mjs";
import { applySyncedKnowledgeGraph, knowledgeGraphForSync } from "./knowledge-graph";
import { encodeAssetBase64, hashBytes, hashText, libraryBindings, readLibrary, readRawAsset } from "./library";

type PublicationEnv = {
  PUBLIC_LIBRARY_REMOTE_URL?: string;
  PUBLIC_LIBRARY_PUBLISH_TOKEN?: string;
};

type SnapshotItem<T> = { id: string; hash: string; value: T };
type AssetManifest = { localId: string; hash: string; contentType: string; byteSize: number };
type Snapshot = {
  modules: Array<SnapshotItem<LibraryModule>>;
  categories: Array<SnapshotItem<Category>>;
  questions: Array<SnapshotItem<Question>>;
  assets: AssetManifest[];
};
type SnapshotManifest = {
  modules: Array<Pick<SnapshotItem<LibraryModule>, "id" | "hash">>;
  categories: Array<Pick<SnapshotItem<Category>, "id" | "hash">>;
  questions: Array<Pick<SnapshotItem<Question>, "id" | "hash">>;
  assets: Array<Pick<AssetManifest, "hash" | "contentType" | "byteSize">>;
};
type SnapshotChanges = Pick<Snapshot, "modules" | "categories" | "questions">;
type EntityUploads = { modules: string[]; categories: string[]; questions: string[] };
type PublishDiff = {
  modules: { added: number; updated: number; deleted: number };
  categories: { added: number; updated: number; deleted: number };
  questions: { added: number; updated: number; deleted: number };
  missingAssets: number;
};
export type PublicationProgress = {
  phase: "snapshot" | "compare" | "assets" | "commit" | "complete";
  current: number;
  total: number;
  label: string;
  diff?: PublishDiff;
};

function publicationEnv() { return env as unknown as PublicationEnv; }

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length); let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

function bearer(request: Request) {
  return request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
}

function requirePublishToken(request: Request) {
  const expected = publicationEnv().PUBLIC_LIBRARY_PUBLISH_TOKEN ?? "";
  if (expected.length < 32 || !constantTimeEqual(bearer(request), expected)) {
    throw new Response(JSON.stringify({ error: "发布凭证无效" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
}

function assetIds(value: unknown) {
  const result = new Set<string>();
  for (const match of JSON.stringify(value).matchAll(/\/api\/assets\/([0-9a-f-]{36})/gi)) result.add(match[1]);
  return [...result];
}

function replaceAssetIds<T>(value: T, hashes: Map<string, string>): T {
  if (typeof value === "string") {
    return value.replace(/\/api\/assets\/([0-9a-f-]{36})/gi, (source, id: string) => hashes.has(id) ? `asset://${hashes.get(id)}` : source) as T;
  }
  if (Array.isArray(value)) return value.map((item) => replaceAssetIds(item, hashes)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceAssetIds(item, hashes)])) as T;
  }
  return value;
}

async function buildSnapshot(user: AuthUser): Promise<Snapshot> {
  const data = await readLibrary(user);
  const ids = new Set<string>();
  for (const question of data.questions) for (const id of assetIds(question)) ids.add(id);
  const assets: AssetManifest[] = [];
  const hashes = new Map<string, string>();
  for (const id of ids) {
    const asset = await readRawAsset(id);
    if (!asset) throw new Error(`题目引用的图片 ${id} 不存在`);
    const hash = asset.contentHash || await hashBytes(asset.bytes);
    hashes.set(id, hash);
    assets.push({ localId: id, hash, contentType: asset.contentType, byteSize: asset.bytes.byteLength });
  }
  const modules = await Promise.all(data.modules.map(async (item) => ({ id: item.id, hash: await hashText(JSON.stringify(item)), value: item })));
  const categories = await Promise.all(data.categories.map(async (item) => ({ id: item.id, hash: await hashText(JSON.stringify(item)), value: item })));
  const questions = await Promise.all(data.questions.map(async (item) => {
    const clean = replaceAssetIds({ ...item, code: undefined, canEdit: undefined, createdBy: undefined, createdByEmail: undefined }, hashes);
    return { id: item.id, hash: await hashText(JSON.stringify(clean)), value: clean };
  }));
  return { modules, categories, questions, assets: deduplicatePublicationAssets(assets) };
}

async function remoteRequest<T>(action: string, body: Record<string, unknown>) {
  const remote = (publicationEnv().PUBLIC_LIBRARY_REMOTE_URL ?? "").replace(/\/$/, "");
  const token = publicationEnv().PUBLIC_LIBRARY_PUBLISH_TOKEN ?? "";
  if (!remote || !token) throw new Error("请在本地配置 PUBLIC_LIBRARY_REMOTE_URL 和 PUBLIC_LIBRARY_PUBLISH_TOKEN");
  const response = await fetch(`${remote}/api/publications`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `远程发布失败（${response.status}）`);
  return result;
}

// Question taxonomy keys point into the knowledge graph, so an edited graph is
// mirrored before the library: production never holds tags it cannot resolve.
async function syncKnowledgeGraph(onProgress?: (progress: PublicationProgress) => void | Promise<void>) {
  const graph = await knowledgeGraphForSync();
  if (!graph) return null;
  await onProgress?.({ phase: "compare", current: 0, total: 1, label: `正在同步知识图谱 v${graph.version}` });
  try {
    return await remoteRequest<{ changed: boolean; version: number }>("knowledge-graph", { graph });
  } catch (error) {
    if (error instanceof Error && error.message.includes("未知发布操作")) throw new Error("线上站点尚未部署知识图谱同步功能，请先部署新版本再发布公共资源库");
    throw error;
  }
}

export async function publishLocalLibrary(user: AuthUser, onProgress?: (progress: PublicationProgress) => void | Promise<void>) {
  if (!user.local) throw new Response(JSON.stringify({ error: "只能从 localhost 发布公共资源库" }), { status: 403, headers: { "Content-Type": "application/json" } });
  const knowledgeGraph = await syncKnowledgeGraph(onProgress);
  await onProgress?.({ phase: "snapshot", current: 0, total: 1, label: "正在计算模块、分类、题目和图片摘要" });
  const snapshot = await buildSnapshot(user);
  await onProgress?.({ phase: "compare", current: 0, total: 1, label: "正在与远程公共版本比对差异" });
  const manifest: SnapshotManifest = {
    modules: snapshot.modules.map(({ id, hash }) => ({ id, hash })),
    categories: snapshot.categories.map(({ id, hash }) => ({ id, hash })),
    questions: snapshot.questions.map(({ id, hash }) => ({ id, hash })),
    assets: snapshot.assets.map(({ hash, contentType, byteSize }) => ({ hash, contentType, byteSize })),
  };
  let publicationId = "";
  try {
    const begin = await remoteRequest<{ publicationId: string; missingAssetHashes: string[]; uploads: EntityUploads; diff: PublishDiff }>("begin", { manifest });
    publicationId = begin.publicationId;
    const missing = new Set(begin.missingAssetHashes);
    const assetsToUpload = snapshot.assets.filter((item) => missing.has(item.hash));
    await onProgress?.({ phase: "assets", current: 0, total: assetsToUpload.length, label: assetsToUpload.length ? `准备上传 ${assetsToUpload.length} 个新图片资源` : "图片资源无需重复上传", diff: begin.diff });
    for (const [index, descriptor] of assetsToUpload.entries()) {
      const asset = await readRawAsset(descriptor.localId);
      if (!asset) throw new Error(`待上传图片 ${descriptor.localId} 已不存在`);
      await remoteRequest("asset", {
        publicationId,
        hash: descriptor.hash,
        contentType: descriptor.contentType,
        base64: encodeAssetBase64(asset.bytes),
      });
      await onProgress?.({ phase: "assets", current: index + 1, total: assetsToUpload.length, label: `已上传 ${index + 1}/${assetsToUpload.length} 个新图片资源`, diff: begin.diff });
    }
    const changed = <T>(items: Array<SnapshotItem<T>>, ids: string[]) => {
      const wanted = new Set(ids);
      return items.filter((item) => wanted.has(item.id));
    };
    const changes: SnapshotChanges = {
      modules: changed(snapshot.modules, begin.uploads.modules),
      categories: changed(snapshot.categories, begin.uploads.categories),
      questions: changed(snapshot.questions, begin.uploads.questions),
    };
    await onProgress?.({ phase: "commit", current: 0, total: 1, label: "正在校验增量并原子切换公共版本", diff: begin.diff });
    const committed = await remoteRequest<{ publishedAt: number }>("commit", { publicationId, manifest, changes });
    await onProgress?.({ phase: "complete", current: 1, total: 1, label: "公共资源库发布完成", diff: begin.diff });
    return { publicationId, diff: begin.diff, publishedAt: committed.publishedAt, knowledgeGraph };
  } catch (error) {
    if (publicationId) await remoteRequest("fail", { publicationId }).catch(() => undefined);
    throw error;
  }
}

async function currentHashes(table: string, publicationId: string | null) {
  if (!publicationId) return new Map<string, string>();
  const rows = await libraryBindings().DB.prepare(`SELECT source_id, content_hash FROM ${table}
    WHERE library_id = 'public' AND publication_id = ?`).bind(publicationId).all<{ source_id: string; content_hash: string }>();
  return new Map<string, string>((rows.results as Array<{ source_id: string; content_hash: string }>).map((row) => [row.source_id, row.content_hash]));
}

function entityDiff(current: Map<string, string>, incoming: Array<{ id: string; hash: string }>) {
  const next = new Map(incoming.map((item) => [item.id, item.hash]));
  return {
    added: [...next.keys()].filter((id) => !current.has(id)).length,
    updated: [...next].filter(([id, hash]) => current.has(id) && current.get(id) !== hash).length,
    deleted: [...current.keys()].filter((id) => !next.has(id)).length,
  };
}

function entityUploads(current: Map<string, string>, incoming: Array<{ id: string; hash: string }>) {
  return incoming.filter((item) => current.get(item.id) !== item.hash).map((item) => item.id);
}

function validEntityManifest(items: Array<{ id: string; hash: string }>) {
  return items.every((item) => typeof item.id === "string" && item.id.length > 0 && item.id.length <= 200 && /^[0-9a-f]{64}$/i.test(item.hash))
    && new Set(items.map((item) => item.id)).size === items.length;
}

function validateManifest(manifest: SnapshotManifest) {
  if (!manifest || !Array.isArray(manifest.modules) || !Array.isArray(manifest.categories) || !Array.isArray(manifest.questions) || !Array.isArray(manifest.assets)) {
    throw new Response(JSON.stringify({ error: "发布清单格式不正确" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (manifest.modules.length > 200 || manifest.categories.length > 2000 || manifest.questions.length > 5000 || manifest.assets.length > 20000) {
    throw new Response(JSON.stringify({ error: "发布内容超过当前单库上限" }), { status: 413, headers: { "Content-Type": "application/json" } });
  }
  if (!validEntityManifest(manifest.modules) || !validEntityManifest(manifest.categories) || !validEntityManifest(manifest.questions)
    || manifest.assets.some((item) => !/^[0-9a-f]{64}$/i.test(item.hash) || !item.contentType || item.byteSize < 0)
    || new Set(manifest.assets.map((item) => item.hash)).size !== manifest.assets.length) {
    throw new Response(JSON.stringify({ error: "发布清单包含无效或重复项目" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
}

async function beginPublication(manifest: SnapshotManifest) {
  validateManifest(manifest);
  const db = libraryBindings().DB;
  const library = await db.prepare("SELECT active_publication_id FROM libraries_v2 WHERE id = 'public'").first<{ active_publication_id: string | null }>();
  const [modules, categories, questions] = await Promise.all([
    currentHashes("library_modules_v2", library?.active_publication_id ?? null),
    currentHashes("library_categories_v2", library?.active_publication_id ?? null),
    currentHashes("library_questions_v2", library?.active_publication_id ?? null),
  ]);
  const existingAssets = manifest.assets.length ? await db.prepare("SELECT content_hash FROM question_assets WHERE content_hash IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(manifest.assets.map((item) => item.hash))).all<{ content_hash: string }>() : { results: [] as Array<{ content_hash: string }> };
  const present = new Set<string>((existingAssets.results as Array<{ content_hash: string }>).map((item) => item.content_hash));
  const missingAssetHashes = manifest.assets.map((item) => item.hash).filter((hash) => !present.has(hash));
  const diff: PublishDiff = {
    modules: entityDiff(modules, manifest.modules), categories: entityDiff(categories, manifest.categories), questions: entityDiff(questions, manifest.questions), missingAssets: missingAssetHashes.length,
  };
  const uploads: EntityUploads = {
    modules: entityUploads(modules, manifest.modules),
    categories: entityUploads(categories, manifest.categories),
    questions: entityUploads(questions, manifest.questions),
  };
  const publicationId = crypto.randomUUID();
  await db.prepare(`INSERT INTO library_publications (id, library_id, status, diff_json, created_at)
    VALUES (?, 'public', 'staging', ?, ?)`)
    .bind(publicationId, JSON.stringify({ diff, uploads, basePublicationId: library?.active_publication_id ?? null, manifestHash: await hashText(JSON.stringify(manifest)) }), Date.now()).run();
  return { publicationId, missingAssetHashes, uploads, diff };
}

function base64Bytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function uploadPublicationAsset(publicationId: string, hash: string, contentType: string, base64: string) {
  const db = libraryBindings().DB;
  const publication = await db.prepare("SELECT status FROM library_publications WHERE id = ? AND library_id = 'public'")
    .bind(publicationId).first<{ status: string }>();
  if (publication?.status !== "staging") throw new Response(JSON.stringify({ error: "发布任务不可用" }), { status: 409, headers: { "Content-Type": "application/json" } });
  const bytes = base64Bytes(base64);
  if (await hashBytes(bytes) !== hash) throw new Response(JSON.stringify({ error: "图片哈希校验失败" }), { status: 400, headers: { "Content-Type": "application/json" } });
  if (await db.prepare("SELECT id FROM question_assets WHERE content_hash = ?").bind(hash).first()) return { ok: true };
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO question_assets (id, content_type, byte_size, created_at, content_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(id, String(contentType || "application/octet-stream").slice(0, 100), bytes.byteLength, Date.now(), hash).run();
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += 500_000, index += 1) {
    const chunk = bytes.slice(offset, Math.min(offset + 500_000, bytes.byteLength));
    statements.push(db.prepare("INSERT INTO question_asset_chunks (asset_id, chunk_index, data) VALUES (?, ?, ?)").bind(id, index, chunk.buffer));
  }
  for (let index = 0; index < statements.length; index += 80) await db.batch(statements.slice(index, index + 80));
  return { ok: true };
}

async function remoteAssetMap(snapshot: Snapshot) {
  const hashes = [...new Set(snapshot.assets.map((item) => item.hash))];
  if (!hashes.length) return new Map<string, string>();
  const rows = await libraryBindings().DB.prepare("SELECT id, content_hash FROM question_assets WHERE content_hash IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(hashes)).all<{ id: string; content_hash: string }>();
  const result = new Map<string, string>((rows.results as Array<{ id: string; content_hash: string }>).map((item) => [item.content_hash, item.id]));
  if (result.size !== hashes.length) throw new Response(JSON.stringify({ error: "尚有图片未上传完成" }), { status: 409, headers: { "Content-Type": "application/json" } });
  return result;
}

function materializeAssetHashes<T>(value: T, assets: Map<string, string>): T {
  if (typeof value === "string") {
    return value.replace(/asset:\/\/([0-9a-f]{64})/gi, (source, hash: string) => assets.has(hash) ? `/api/assets/${assets.get(hash)}` : source) as T;
  }
  if (Array.isArray(value)) return value.map((item) => materializeAssetHashes(item, assets)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materializeAssetHashes(item, assets)])) as T;
  return value;
}

async function verifyChangedItems<T>(kind: string, manifest: Array<{ id: string; hash: string }>, expectedIds: string[], items: Array<SnapshotItem<T>>) {
  const expected = new Set(expectedIds);
  const manifestHashes = new Map(manifest.map((item) => [item.id, item.hash]));
  if (items.length !== expected.size || new Set(items.map((item) => item.id)).size !== items.length || items.some((item) => !expected.has(item.id))) {
    throw new Response(JSON.stringify({ error: `${kind}增量内容不完整` }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  for (const item of items) {
    const actual = await hashText(JSON.stringify(item.value));
    if (item.hash !== manifestHashes.get(item.id) || actual !== item.hash) {
      throw new Response(JSON.stringify({ error: `${kind}内容哈希校验失败` }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
  }
}

function unchangedItems(items: Array<{ id: string; hash: string }>, changedIds: string[]) {
  const changed = new Set(changedIds);
  return items.filter((item) => !changed.has(item.id));
}

async function commitPublication(publicationId: string, manifest: SnapshotManifest, changes: SnapshotChanges) {
  validateManifest(manifest);
  if (!changes || !Array.isArray(changes.modules) || !Array.isArray(changes.categories) || !Array.isArray(changes.questions)) {
    throw new Response(JSON.stringify({ error: "发布增量格式不正确" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const db = libraryBindings().DB;
  const publication = await db.prepare("SELECT status, diff_json FROM library_publications WHERE id = ? AND library_id = 'public'")
    .bind(publicationId).first<{ status: string; diff_json: string }>();
  if (publication?.status !== "staging") throw new Response(JSON.stringify({ error: "发布任务不可提交" }), { status: 409, headers: { "Content-Type": "application/json" } });
  const metadata = JSON.parse(publication.diff_json) as { uploads: EntityUploads; basePublicationId: string | null; manifestHash: string };
  if (await hashText(JSON.stringify(manifest)) !== metadata.manifestHash) throw new Response(JSON.stringify({ error: "发布清单已发生变化" }), { status: 409 });
  const current = await db.prepare("SELECT active_publication_id FROM libraries_v2 WHERE id = 'public'").first<{ active_publication_id: string | null }>();
  if ((current?.active_publication_id ?? null) !== metadata.basePublicationId) throw new Response(JSON.stringify({ error: "公共库已被另一发布任务更新，请重新发布" }), { status: 409 });
  await verifyChangedItems("模块", manifest.modules, metadata.uploads.modules, changes.modules);
  await verifyChangedItems("分类", manifest.categories, metadata.uploads.categories, changes.categories);
  await verifyChangedItems("题目", manifest.questions, metadata.uploads.questions, changes.questions);
  const moduleIds = new Set(manifest.modules.map((item) => item.id));
  const categoryModules = new Map<string, string>(changes.categories.map((item) => [item.id, String(item.value.moduleId ?? "")]));
  for (const item of unchangedItems(manifest.categories, metadata.uploads.categories)) {
    const row = await db.prepare("SELECT module_source_id FROM library_categories_v2 WHERE library_id = 'public' AND publication_id = ? AND source_id = ?")
      .bind(metadata.basePublicationId, item.id).first<{ module_source_id: string }>();
    if (row) categoryModules.set(item.id, row.module_source_id);
  }
  if (categoryModules.size !== manifest.categories.length || [...categoryModules.values()].some((moduleId) => !moduleIds.has(moduleId))) {
    throw new Response(JSON.stringify({ error: "分类引用了不存在的模块" }), { status: 400 });
  }
  for (const item of changes.categories) {
    const parentId = item.value.parentId;
    if (parentId !== item.value.moduleId && (!categoryModules.has(parentId ?? "") || categoryModules.get(parentId ?? "") !== item.value.moduleId)) {
      throw new Response(JSON.stringify({ error: "分类引用了不存在或跨模块的父分类" }), { status: 400 });
    }
  }
  for (const item of changes.questions) {
    const value = item.value;
    if (!value.moduleId || !moduleIds.has(value.moduleId)
      || (value.categoryId !== value.moduleId && categoryModules.get(value.categoryId) !== value.moduleId)) {
      throw new Response(JSON.stringify({ error: "题目引用了不存在或跨模块的分类" }), { status: 400 });
    }
  }
  const assets = await remoteAssetMap({ ...changes, assets: manifest.assets.map((item) => ({ ...item, localId: "" })) });
  const statements: D1PreparedStatement[] = [];
  for (const item of unchangedItems(manifest.modules, metadata.uploads.modules)) {
    statements.push(db.prepare(`INSERT INTO library_modules_v2
      (row_id, source_id, library_id, publication_id, name, subtitle, sort_order, content_hash, created_by, created_at, updated_at)
      SELECT ?, source_id, 'public', ?, name, subtitle, sort_order, content_hash, NULL, created_at, updated_at
      FROM library_modules_v2 WHERE library_id = 'public' AND publication_id = ? AND source_id = ? AND content_hash = ?`)
      .bind(`${publicationId}:module:${item.id}`, publicationId, metadata.basePublicationId, item.id, item.hash));
  }
  for (const item of changes.modules) {
    const value = item.value;
    statements.push(db.prepare(`INSERT INTO library_modules_v2
      (row_id, source_id, library_id, publication_id, name, subtitle, sort_order, content_hash, created_by, created_at, updated_at)
      VALUES (?, ?, 'public', ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .bind(`${publicationId}:module:${item.id}`, item.id, publicationId, value.name, value.subtitle, value.sortOrder, item.hash, value.createdAt, value.updatedAt));
  }
  for (const item of unchangedItems(manifest.categories, metadata.uploads.categories)) {
    statements.push(db.prepare(`INSERT INTO library_categories_v2
      (row_id, source_id, library_id, publication_id, module_source_id, parent_source_id, name, sort_order, content_hash, created_by, created_at)
      SELECT ?, source_id, 'public', ?, module_source_id, parent_source_id, name, sort_order, content_hash, NULL, created_at
      FROM library_categories_v2 WHERE library_id = 'public' AND publication_id = ? AND source_id = ? AND content_hash = ?`)
      .bind(`${publicationId}:category:${item.id}`, publicationId, metadata.basePublicationId, item.id, item.hash));
  }
  for (const item of changes.categories) {
    const value = item.value;
    statements.push(db.prepare(`INSERT INTO library_categories_v2
      (row_id, source_id, library_id, publication_id, module_source_id, parent_source_id, name, sort_order, content_hash, created_by, created_at)
      VALUES (?, ?, 'public', ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .bind(`${publicationId}:category:${item.id}`, item.id, publicationId, value.moduleId, value.parentId, value.name, value.createdAt, item.hash, value.createdAt));
  }
  for (const item of unchangedItems(manifest.questions, metadata.uploads.questions)) {
    statements.push(db.prepare(`INSERT INTO library_questions_v2
      (row_id, source_id, library_id, publication_id, module_source_id, category_source_id,
       payload_json, content_hash, created_by, created_at, updated_at)
      SELECT ?, source_id, 'public', ?, module_source_id, category_source_id,
       payload_json, content_hash, NULL, created_at, updated_at
      FROM library_questions_v2 WHERE library_id = 'public' AND publication_id = ? AND source_id = ? AND content_hash = ?`)
      .bind(`${publicationId}:question:${item.id}`, publicationId, metadata.basePublicationId, item.id, item.hash));
  }
  for (const item of changes.questions) {
    const value = materializeAssetHashes(item.value, assets);
    const payload = JSON.stringify({ ...value, createdBy: undefined, createdByEmail: undefined, canEdit: undefined, code: undefined });
    statements.push(db.prepare(`INSERT INTO library_questions_v2
      (row_id, source_id, library_id, publication_id, module_source_id, category_source_id,
       payload_json, content_hash, created_by, created_at, updated_at)
      VALUES (?, ?, 'public', ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .bind(`${publicationId}:question:${item.id}`, item.id, publicationId, value.moduleId,
        value.categoryId === value.moduleId ? null : value.categoryId, payload, item.hash, value.createdAt, value.updatedAt));
  }
  for (const id of assets.values()) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO asset_library_access
      (access_key, asset_id, library_id, publication_id, created_at) VALUES (?, ?, 'public', ?, ?)`)
      .bind(`public|${publicationId}|${id}`, id, publicationId, Date.now()));
  }
  for (let index = 0; index < statements.length; index += 80) await db.batch(statements.slice(index, index + 80));
  const now = Date.now();
  const finalStatements = [
    db.prepare("UPDATE library_publications SET status = 'active', committed_at = ? WHERE id = ?").bind(now, publicationId),
    db.prepare("UPDATE libraries_v2 SET active_publication_id = ?, published_at = ? WHERE id = 'public'").bind(publicationId, now),
  ];
  if (current?.active_publication_id) finalStatements.push(db.prepare("UPDATE library_publications SET status = 'superseded' WHERE id = ? AND id <> ?").bind(current.active_publication_id, publicationId));
  await db.batch(finalStatements);
  return { publishedAt: now };
}

async function failPublication(publicationId: string) {
  await libraryBindings().DB.prepare("UPDATE library_publications SET status = 'failed' WHERE id = ? AND library_id = 'public' AND status = 'staging'")
    .bind(publicationId).run();
  return { ok: true };
}

export async function handleInternalPublication(request: Request, body: Record<string, unknown>) {
  requirePublishToken(request);
  if (body.action === "begin") return beginPublication(body.manifest as Parameters<typeof beginPublication>[0]);
  if (body.action === "asset") return uploadPublicationAsset(String(body.publicationId ?? ""), String(body.hash ?? ""), String(body.contentType ?? ""), String(body.base64 ?? ""));
  if (body.action === "commit") return commitPublication(String(body.publicationId ?? ""), body.manifest as SnapshotManifest, body.changes as SnapshotChanges);
  if (body.action === "fail") return failPublication(String(body.publicationId ?? ""));
  if (body.action === "knowledge-graph") return applySyncedKnowledgeGraph(body.graph);
  throw new Response(JSON.stringify({ error: "未知发布操作" }), { status: 400, headers: { "Content-Type": "application/json" } });
}
