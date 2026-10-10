import { env } from "cloudflare:workers";
import { CHINA_MATH_SEED_DOCUMENT } from "../china-curriculum-taxonomy.mjs";
import {
  createKnowledgeGraphIndex, diffKnowledgeGraphs, normalizeKnowledgeGraph, preservePublishedNodes, summarizeKnowledgeGraphDiff, validateKnowledgeGraph,
  type KnowledgeGraphIndex,
} from "../knowledge-graph-core.mjs";
import type {
  AuthUser, KnowledgeGraphChangeSummary, KnowledgeGraphCoverage, KnowledgeGraphDocument, KnowledgeGraphEditorState, KnowledgeGraphVersion, PublishedKnowledgeGraph,
} from "../types";

type AppEnv = { DB: D1Database };
type GraphRow = {
  published_version: number; draft_json: string | null; draft_base_version: number | null; draft_revision: number; draft_updated_at: number | null;
};
type VersionRow = { version: number; framework_version: string; document_json: string; content_hash: string; note: string; summary_json: string; published_at: number };
export type LoadedKnowledgeGraph = PublishedKnowledgeGraph & { index: KnowledgeGraphIndex; hash: string };

export const KNOWLEDGE_GRAPH_ID = "cn-math-junior";
const SEED_VERSION = 1;
const SEED_NOTE = "初始课程骨架";
// D1 caps a single row at 2 MB; keep the document comfortably below it.
const MAX_DOCUMENT_BYTES = 1_900_000;

function db() {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings.DB;
}

function responseError(message: string, status: number, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), { status, headers: { "Content-Type": "application/json" } });
}

async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function missingGraphTables(error: unknown) { return error instanceof Error && /no such table: knowledge_graph/i.test(error.message); }

async function loaded(document: KnowledgeGraphDocument, version: number, publishedAt: number | null, note: string): Promise<LoadedKnowledgeGraph> {
  const index = createKnowledgeGraphIndex(document, { version });
  return { graphId: document.graphId, version, frameworkVersion: index.frameworkVersion, publishedAt, note, document, index, hash: await sha256Text(JSON.stringify(document)) };
}

let seedGraph: Promise<LoadedKnowledgeGraph> | null = null;
let publishedCache: LoadedKnowledgeGraph | null = null;

function seed() {
  seedGraph ??= loaded(CHINA_MATH_SEED_DOCUMENT, SEED_VERSION, null, SEED_NOTE);
  return seedGraph;
}

// One cheap pointer read per request; the parsed document and index are cached
// per isolate until another publish moves the pointer.
export async function loadPublishedKnowledgeGraph(): Promise<LoadedKnowledgeGraph> {
  let row: { published_version: number } | null;
  try {
    row = await db().prepare("SELECT published_version FROM knowledge_graphs WHERE id = ?").bind(KNOWLEDGE_GRAPH_ID).first<{ published_version: number }>();
  } catch (error) {
    if (missingGraphTables(error)) return seed();
    throw error;
  }
  const version = Number(row?.published_version ?? SEED_VERSION);
  if (version <= SEED_VERSION) return seed();
  if (publishedCache?.version === version) return publishedCache;
  const stored = await db().prepare(`SELECT version, framework_version, document_json, content_hash, note, summary_json, published_at
    FROM knowledge_graph_versions WHERE graph_id = ? AND version = ?`).bind(KNOWLEDGE_GRAPH_ID, version).first<VersionRow>();
  if (!stored) throw new Error(`知识图谱 v${version} 的发布记录缺失`);
  publishedCache = await loaded(normalizeKnowledgeGraph(JSON.parse(stored.document_json)), version, Number(stored.published_at), stored.note);
  return publishedCache;
}

function publicView(graph: LoadedKnowledgeGraph): PublishedKnowledgeGraph {
  return { graphId: graph.graphId, version: graph.version, frameworkVersion: graph.frameworkVersion, publishedAt: graph.publishedAt, note: graph.note, document: graph.document };
}

export async function readPublishedKnowledgeGraph() { return publicView(await loadPublishedKnowledgeGraph()); }

async function graphRow(): Promise<GraphRow> {
  const now = Date.now();
  await db().prepare(`INSERT OR IGNORE INTO knowledge_graphs (id, published_version, draft_revision, created_at, updated_at)
    VALUES (?, 1, 0, ?, ?)`).bind(KNOWLEDGE_GRAPH_ID, now, now).run();
  const row = await db().prepare(`SELECT published_version, draft_json, draft_base_version, draft_revision, draft_updated_at
    FROM knowledge_graphs WHERE id = ?`).bind(KNOWLEDGE_GRAPH_ID).first<GraphRow>();
  if (!row) throw new Error("知识图谱尚未初始化");
  return row;
}

// Like the public library, the shared graph is only maintained from localhost
// and reaches production through the public-library publish.
export function requireKnowledgeGraphEditor(user: AuthUser) {
  if (!user.local) throw responseError("知识图谱只能在 localhost 本地管理员模式下编辑，发布公共资源库时会同步到线上", 403);
}

function revisionConflict() {
  return responseError("草稿已在其他窗口更新，请刷新后再继续编辑", 409, { code: "revision-conflict" });
}

function parseDocument(value: unknown) {
  const document = normalizeKnowledgeGraph(value);
  const json = JSON.stringify(document);
  if (new TextEncoder().encode(json).length > MAX_DOCUMENT_BYTES) throw responseError("图谱内容超过 1.9 MB 上限，请拆分或精简描述", 413);
  if (!document.nodes.length) throw responseError("图谱草稿不能为空", 400);
  return { document, json };
}

export async function readKnowledgeGraphEditor(user: AuthUser): Promise<KnowledgeGraphEditorState> {
  requireKnowledgeGraphEditor(user);
  const row = await graphRow(); const published = await loadPublishedKnowledgeGraph();
  const draft = row.draft_json ? normalizeKnowledgeGraph(JSON.parse(row.draft_json)) : null;
  return {
    published: publicView(published),
    draft: draft ? { document: draft, baseVersion: Number(row.draft_base_version ?? published.version), updatedAt: Number(row.draft_updated_at ?? 0),
      issues: validateKnowledgeGraph(draft, { previous: published.document }).errors } : null,
    revision: Number(row.draft_revision),
  };
}

async function writeDraft(user: AuthUser, revision: number, json: string, baseVersion: number) {
  const now = Date.now();
  const result = await db().prepare(`UPDATE knowledge_graphs SET draft_json = ?, draft_base_version = COALESCE(draft_base_version, ?),
      draft_revision = draft_revision + 1, draft_updated_at = ?, draft_updated_by = ?, updated_at = ?
    WHERE id = ? AND draft_revision = ?`).bind(json, baseVersion, now, user.id, now, KNOWLEDGE_GRAPH_ID, revision).run();
  if (!result.meta.changes) throw revisionConflict();
  return { revision: revision + 1, updatedAt: now };
}

// Drafts may be temporarily invalid (an empty name while typing); issues are
// reported back and publishing is what enforces a clean graph.
export async function saveKnowledgeGraphDraft(user: AuthUser, input: { revision?: unknown; document?: unknown }) {
  requireKnowledgeGraphEditor(user);
  const { document, json } = parseDocument(input.document);
  await graphRow(); const published = await loadPublishedKnowledgeGraph();
  const saved = await writeDraft(user, Number(input.revision), json, published.version);
  return { ...saved, issues: validateKnowledgeGraph(document, { previous: published.document }).errors };
}

export async function discardKnowledgeGraphDraft(user: AuthUser, input: { revision?: unknown }) {
  requireKnowledgeGraphEditor(user);
  const now = Date.now(); const revision = Number(input.revision);
  const result = await db().prepare(`UPDATE knowledge_graphs SET draft_json = NULL, draft_base_version = NULL, draft_revision = draft_revision + 1,
      draft_updated_at = ?, draft_updated_by = ?, updated_at = ? WHERE id = ? AND draft_revision = ?`)
    .bind(now, user.id, now, KNOWLEDGE_GRAPH_ID, revision).run();
  if (!result.meta.changes) throw revisionConflict();
  return { revision: revision + 1 };
}

function seedVersionStatement(publishedBy: string | null) {
  return db().prepare(`INSERT OR IGNORE INTO knowledge_graph_versions
    (graph_id, version, framework_version, document_json, content_hash, note, summary_json, published_by, published_at)
    VALUES (?, 1, ?, ?, '', ?, '{}', ?, 0)`)
    .bind(KNOWLEDGE_GRAPH_ID, `${CHINA_MATH_SEED_DOCUMENT.graphId}-v1`, JSON.stringify(CHINA_MATH_SEED_DOCUMENT), SEED_NOTE, publishedBy);
}

async function insertVersion(input: {
  current: LoadedKnowledgeGraph; document: KnowledgeGraphDocument; note: string; summary: KnowledgeGraphChangeSummary;
  publishedBy: string | null; sourceVersion: number | null; revision: number | null;
}) {
  const version = input.current.version + 1; const now = Date.now(); const json = JSON.stringify(input.document);
  const guard = input.revision == null ? "published_version = ?" : "published_version = ? AND draft_revision = ?";
  const guardBindings = input.revision == null ? [input.current.version] : [input.current.version, input.revision];
  const statements = [];
  if (input.current.version === SEED_VERSION) statements.push(seedVersionStatement(input.publishedBy));
  statements.push(db().prepare(`INSERT INTO knowledge_graph_versions
      (graph_id, version, framework_version, document_json, content_hash, note, summary_json, source_version, published_by, published_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM knowledge_graphs WHERE id = ? AND ${guard})`)
    .bind(KNOWLEDGE_GRAPH_ID, version, `${input.document.graphId}-v${version}`, json, await sha256Text(json), input.note.slice(0, 200),
      JSON.stringify(input.summary), input.sourceVersion, input.publishedBy, now, KNOWLEDGE_GRAPH_ID, ...guardBindings));
  statements.push(db().prepare(`UPDATE knowledge_graphs SET published_version = ?, draft_json = NULL, draft_base_version = NULL,
      draft_revision = draft_revision + 1, updated_at = ? WHERE id = ? AND ${guard}`)
    .bind(version, now, KNOWLEDGE_GRAPH_ID, ...guardBindings));
  const results = await db().batch(statements);
  if (!results[results.length - 1].meta.changes) return null;
  publishedCache = null;
  return { version, frameworkVersion: `${input.document.graphId}-v${version}`, publishedAt: now };
}

export async function publishKnowledgeGraph(user: AuthUser, input: { revision?: unknown; note?: unknown }) {
  requireKnowledgeGraphEditor(user);
  const row = await graphRow(); const revision = Number(input.revision);
  if (revision !== Number(row.draft_revision)) throw revisionConflict();
  if (!row.draft_json) throw responseError("没有需要发布的草稿", 400);
  const current = await loadPublishedKnowledgeGraph();
  const document = normalizeKnowledgeGraph(JSON.parse(row.draft_json));
  const { errors } = validateKnowledgeGraph(document, { previous: current.document });
  if (errors.length) throw responseError(`草稿还有 ${errors.length} 个问题需要处理`, 400, { issues: errors });
  const summary = summarizeKnowledgeGraphDiff(diffKnowledgeGraphs(current.document, document));
  if (!Object.values(summary).some(Boolean)) {
    const discarded = await discardKnowledgeGraphDraft(user, { revision });
    return { version: current.version, frameworkVersion: current.frameworkVersion, publishedAt: current.publishedAt, summary, unchanged: true, revision: discarded.revision };
  }
  const note = typeof input.note === "string" ? input.note.trim() : "";
  const published = await insertVersion({ current, document, note, summary, publishedBy: user.id, sourceVersion: null, revision });
  if (!published) throw revisionConflict();
  return { ...published, summary, unchanged: false, revision: revision + 1 };
}

export async function readKnowledgeGraphVersions(user: AuthUser): Promise<KnowledgeGraphVersion[]> {
  requireKnowledgeGraphEditor(user);
  const rows = await db().prepare(`SELECT version, framework_version, note, summary_json, published_at FROM knowledge_graph_versions
    WHERE graph_id = ? ORDER BY version DESC LIMIT 60`).bind(KNOWLEDGE_GRAPH_ID).all<Omit<VersionRow, "document_json" | "content_hash">>();
  const versions: KnowledgeGraphVersion[] = rows.results.map((row: Omit<VersionRow, "document_json" | "content_hash">) => {
    let summary: KnowledgeGraphChangeSummary | null = null;
    try { const parsed = JSON.parse(row.summary_json) as KnowledgeGraphChangeSummary; summary = typeof parsed.nodesAdded === "number" ? parsed : null; } catch { summary = null; }
    return { version: Number(row.version), frameworkVersion: row.framework_version, note: row.note, summary, publishedAt: Number(row.published_at) || null };
  });
  if (!versions.some((item) => item.version === SEED_VERSION)) {
    versions.push({ version: SEED_VERSION, frameworkVersion: `${CHINA_MATH_SEED_DOCUMENT.graphId}-v1`, note: SEED_NOTE, summary: null, publishedAt: null });
  }
  return versions;
}

// Restoring an old version keeps every node published since then as archived,
// so the restored draft still satisfies "published nodes are never deleted".
export async function restoreKnowledgeGraphVersion(user: AuthUser, input: { version?: unknown; revision?: unknown }) {
  requireKnowledgeGraphEditor(user);
  const version = Math.round(Number(input.version));
  const current = await loadPublishedKnowledgeGraph();
  let document: KnowledgeGraphDocument = CHINA_MATH_SEED_DOCUMENT;
  if (version !== SEED_VERSION) {
    const stored = await db().prepare("SELECT document_json FROM knowledge_graph_versions WHERE graph_id = ? AND version = ?")
      .bind(KNOWLEDGE_GRAPH_ID, version).first<{ document_json: string }>();
    if (!stored) throw responseError("该版本不存在", 404);
    document = normalizeKnowledgeGraph(JSON.parse(stored.document_json));
  }
  const { json } = parseDocument(preservePublishedNodes(document, current.document));
  await graphRow();
  return writeDraft(user, Number(input.revision), json, current.version);
}

function versionWhere(publicationId: string | null) { return publicationId == null ? "publication_id IS NULL" : "publication_id = ?"; }

async function coverageFor(libraryId: string, publicationId: string | null, graph: KnowledgeGraphIndex) {
  const counts: Record<string, number> = {};
  try {
    const rows = await db().prepare(`SELECT taxonomy.value AS node_key, COUNT(DISTINCT questions.source_id) AS total
      FROM library_questions_v2 AS questions, json_each(questions.payload_json, '$.taxonomyKeys') AS taxonomy
      WHERE questions.library_id = ? AND questions.${versionWhere(publicationId)} AND questions.deleted_at IS NULL GROUP BY taxonomy.value`)
      .bind(libraryId, ...(publicationId == null ? [] : [publicationId])).all<{ node_key: string; total: number }>();
    for (const row of rows.results) {
      const key = graph.resolveKey(String(row.node_key));
      if (key) counts[key] = (counts[key] ?? 0) + Number(row.total);
    }
  } catch (error) {
    // Coverage is advisory; a malformed legacy payload must not block the graph.
    console.error("知识图谱题库覆盖统计失败", error);
  }
  return counts;
}

export async function readKnowledgeGraphCoverage(graph: LoadedKnowledgeGraph): Promise<KnowledgeGraphCoverage> {
  const library = await db().prepare("SELECT active_publication_id FROM libraries_v2 WHERE id = 'public'").first<{ active_publication_id: string | null }>();
  return { public: library ? await coverageFor("public", library.active_publication_id, graph.index) : {} };
}

export async function knowledgeGraphForSync() {
  const graph = await loadPublishedKnowledgeGraph();
  if (graph.version <= SEED_VERSION) return null;
  return { graphId: graph.graphId, version: graph.version, hash: graph.hash, document: graph.document };
}

// Production receives the graph from the local publish. Its own version numbers
// may differ from localhost, so the source version is recorded for tracing.
export async function applySyncedKnowledgeGraph(payload: unknown) {
  const input = (payload && typeof payload === "object" ? payload : {}) as { graphId?: unknown; version?: unknown; hash?: unknown; document?: unknown };
  if (input.graphId !== KNOWLEDGE_GRAPH_ID) throw responseError("知识图谱编号不匹配", 400);
  const { document, json } = parseDocument(input.document);
  if (await sha256Text(json) !== input.hash) throw responseError("知识图谱内容校验失败", 400);
  const current = await loadPublishedKnowledgeGraph();
  if (current.hash === input.hash) return { changed: false, version: current.version };
  const { errors } = validateKnowledgeGraph(document, { previous: current.document });
  if (errors.length) throw responseError(`线上知识图谱无法更新：${errors[0].message}`, 409, { issues: errors });
  const sourceVersion = Math.round(Number(input.version)) || null;
  const summary = summarizeKnowledgeGraphDiff(diffKnowledgeGraphs(current.document, document));
  await graphRow();
  const published = await insertVersion({ current, document, note: `同步自本地 v${sourceVersion ?? "?"}`, summary, publishedBy: null, sourceVersion, revision: null });
  if (!published) throw responseError("线上知识图谱正在被另一任务更新，请重新发布", 409);
  return { changed: true, version: published.version };
}
