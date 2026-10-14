import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CHINA_MATH_SEED_DOCUMENT } from "../lib/china-curriculum-taxonomy.mjs";
import { addKnowledgeEdge, addKnowledgeNode, updateKnowledgeNode } from "../lib/knowledge-graph-edit.mjs";
import { loopbackFetch as fetch } from "./helpers/loopback-fetch.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const CONFIG = join(ROOT, "dist", "server", "wrangler.json");
const TOKEN = "fedcba9876543210fedcba9876543210";
const INVITE = "knowledge-graph-e2e-invite";
const topic = (name) => `cn-math:topic:${name}`;

function command(args) {
  const result = spawnSync(WRANGLER, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function startWorker(port, persistTo, vars) {
  const args = [join(ROOT, "scripts/start-local-test-worker.mjs"), CONFIG, String(port), persistTo, JSON.stringify(vars)];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForServer(url, worker) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (worker.child.exitCode != null) throw new Error(`Worker 提前退出\n${worker.output()}`);
    try { if ((await fetch(url)).ok) return; } catch { /* 等待监听端口 */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  throw new Error(`Worker 启动超时\n${worker.output()}`);
}

async function stopWorker(worker) {
  if (worker.child.exitCode != null) return;
  worker.child.kill("SIGINT");
  await Promise.race([new Promise((resolveExit) => worker.child.once("exit", resolveExit)), new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
  if (worker.child.exitCode == null) worker.child.kill("SIGKILL");
}

async function jsonRequest(base, path, { cookie = "", method = "GET", body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders.Cookie = cookie;
  if (body !== undefined) { requestHeaders["Content-Type"] = "application/json"; requestHeaders.Origin = base; }
  const response = await fetch(`${base}${path}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, payload: await response.json().catch(() => ({})) };
}

test("teachers edit the knowledge graph as a guarded draft, publish versions and mirror them to production", { timeout: 180_000 }, async () => {
  const [localPort, remotePort] = await Promise.all([freePort(), freePort()]);
  const [localState, remoteState] = await Promise.all([mkdtemp(join(tmpdir(), "zhiti-graph-local-")), mkdtemp(join(tmpdir(), "zhiti-graph-remote-"))]);
  for (const state of [localState, remoteState]) command(["d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "--config", join(ROOT, "wrangler.jsonc")]);
  const remote = startWorker(remotePort, remoteState, { LOCAL_ADMIN_MODE: "false", REGISTRATION_INVITE_CODE: INVITE, ADMIN_EMAIL: "admin@graph.test", PUBLIC_LIBRARY_PUBLISH_TOKEN: TOKEN });
  const remoteBase = `http://public.localtest.me:${remotePort}`; const remoteInternal = `http://127.0.0.1:${remotePort}`;
  let local;
  try {
    await waitForServer(`${remoteBase}/api/library?scope=public`, remote);
    local = startWorker(localPort, localState, { LOCAL_ADMIN_MODE: "true", REGISTRATION_INVITE_CODE: INVITE, ADMIN_EMAIL: "admin@graph.test",
      PUBLIC_LIBRARY_PUBLISH_TOKEN: TOKEN, PUBLIC_LIBRARY_REMOTE_URL: remoteInternal });
    const localBase = `http://localhost:${localPort}`;
    await waitForServer(`${localBase}/api/auth/me`, local);

    const registration = await jsonRequest(remoteBase, "/api/auth/register", { method: "POST", body: { email: "teacher@graph.test", password: "password123", inviteCode: INVITE } });
    const teacher = (registration.response.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const remoteGraph = await jsonRequest(remoteBase, "/api/knowledge-graph", { cookie: teacher });
    assert.equal(remoteGraph.payload.graph.version, 1);
    assert.equal(remoteGraph.payload.permissions.canEdit, false);
    assert.equal((await jsonRequest(remoteBase, "/api/knowledge-graph/draft", { cookie: teacher })).response.status, 403, "production teachers cannot open the editor");
    assert.equal((await jsonRequest(remoteBase, "/api/knowledge-graph/draft", { cookie: teacher, method: "PUT", body: { revision: 0, document: CHINA_MATH_SEED_DOCUMENT } })).response.status, 403);

    const editor = await jsonRequest(localBase, "/api/knowledge-graph/draft");
    assert.deepEqual([editor.payload.revision, editor.payload.draft, editor.payload.published.version], [0, null, 1]);
    const withPoint = addKnowledgeNode(editor.payload.published.document, { level: "point", parentKey: topic("quadratic-function"), label: "顶点式" });
    const pointKey = withPoint.key;
    const valid = addKnowledgeEdge(updateKnowledgeNode(withPoint.document, pointKey, { aliases: ["配方", "顶点坐标"] }), topic("quadratic-equation"), pointKey, "prerequisite", "配方法得到顶点式");
    const saved = await jsonRequest(localBase, "/api/knowledge-graph/draft", { method: "PUT", body: { revision: 0, document: valid } });
    assert.equal(saved.response.status, 200); assert.equal(saved.payload.revision, 1); assert.deepEqual(saved.payload.issues, []);
    const stale = await jsonRequest(localBase, "/api/knowledge-graph/draft", { method: "PUT", body: { revision: 0, document: valid } });
    assert.equal(stale.response.status, 409, "a second window with an old revision must not overwrite the draft");
    assert.equal(stale.payload.code, "revision-conflict");

    const cyclic = structuredClone(valid);
    cyclic.edges.push({ sourceKey: topic("linear-function"), targetKey: topic("rational-numbers"), relationship: "prerequisite", strength: "hard", reason: "" });
    const invalidDraft = await jsonRequest(localBase, "/api/knowledge-graph/draft", { method: "PUT", body: { revision: 1, document: cyclic } });
    assert.equal(invalidDraft.response.status, 200, "drafts may hold work in progress");
    assert.ok(invalidDraft.payload.issues.some((issue) => issue.code === "cycle"));
    const blocked = await jsonRequest(localBase, "/api/knowledge-graph/publish", { method: "POST", body: { revision: 2 } });
    assert.equal(blocked.response.status, 400);
    assert.match(blocked.payload.issues[0].message, /形成循环/);
    assert.equal((await jsonRequest(localBase, "/api/knowledge-graph/draft", { method: "PUT", body: { revision: 2, document: valid } })).payload.revision, 3);

    const published = await jsonRequest(localBase, "/api/knowledge-graph/publish", { method: "POST", body: { revision: 3, note: "补充顶点式" } });
    assert.equal(published.response.status, 200);
    assert.deepEqual([published.payload.version, published.payload.frameworkVersion, published.payload.summary.nodesAdded, published.payload.summary.edgesAdded], [2, "cn-math-junior-v2", 1, 1]);
    const overview = await jsonRequest(localBase, "/api/knowledge-graph");
    assert.equal(overview.payload.graph.version, 2);
    assert.equal(overview.payload.graph.document.nodes.find((node) => node.key === pointKey).label, "顶点式");
    assert.ok(overview.payload.profile.nodes.some((node) => node.key === pointKey), "profiles are built from the published version");

    const localModule = await jsonRequest(localBase, "/api/modules", { method: "POST", body: { scope: "public", module: { name: "二次函数专题", subtitle: "" } } });
    const moduleId = localModule.payload.module.id;
    const question = await jsonRequest(localBase, "/api/questions", { method: "POST", body: { scope: "public", question: {
      id: "vertex-question", moduleId, categoryId: moduleId, type: "解答题", difficulty: "中等", provenance: "来源待核实", stem: "把 y=x²-4x+3 化成顶点式",
      options: [], answer: "y=(x-2)²-1", analysis: "配方", source: "图谱回归", tags: ["配方"], createdAt: 1, updatedAt: 1,
    } } });
    assert.deepEqual(question.payload.question.taxonomyKeys, [pointKey], "new aliases are used for tagging as soon as the graph is published");
    assert.equal((await jsonRequest(localBase, "/api/knowledge-graph")).payload.coverage.public[pointKey], 1);

    const withoutPoint = { ...valid, nodes: valid.nodes.filter((node) => node.key !== pointKey), edges: valid.edges.filter((edge) => edge.targetKey !== pointKey) };
    const deletingDraft = await jsonRequest(localBase, "/api/knowledge-graph/draft", { method: "PUT", body: { revision: 4, document: withoutPoint } });
    assert.ok(deletingDraft.payload.issues.some((issue) => issue.code === "removed-published"));
    assert.equal((await jsonRequest(localBase, "/api/knowledge-graph/publish", { method: "POST", body: { revision: 5 } })).response.status, 400, "published keys are archived, never deleted");
    assert.equal((await jsonRequest(localBase, "/api/knowledge-graph/draft", { method: "DELETE", body: { revision: 5 } })).payload.revision, 6);

    const versions = await jsonRequest(localBase, "/api/knowledge-graph/versions");
    assert.deepEqual(versions.payload.versions.map((item) => [item.version, item.note]), [[2, "补充顶点式"], [1, "初始课程骨架"]]);
    const restored = await jsonRequest(localBase, "/api/knowledge-graph/versions", { method: "POST", body: { version: 1, revision: 6 } });
    assert.equal(restored.payload.revision, 7);
    const restoredDraft = await jsonRequest(localBase, "/api/knowledge-graph/draft");
    assert.equal(restoredDraft.payload.draft.document.nodes.find((node) => node.key === pointKey).status, "archived", "restoring v1 keeps later nodes as archived history");
    assert.deepEqual(restoredDraft.payload.draft.issues, []);
    assert.equal((await jsonRequest(localBase, "/api/knowledge-graph/draft", { method: "DELETE", body: { revision: 7 } })).response.status, 200);

    const mirror = await jsonRequest(localBase, "/api/publications", { method: "POST", body: { action: "publish-local" } });
    assert.equal(mirror.response.status, 200, JSON.stringify(mirror.payload));
    assert.deepEqual(mirror.payload.knowledgeGraph, { changed: true, version: 2 });
    const mirrored = await jsonRequest(remoteBase, "/api/knowledge-graph", { cookie: teacher });
    assert.equal(mirrored.payload.graph.version, 2);
    assert.ok(mirrored.payload.graph.document.nodes.some((node) => node.key === pointKey));
    assert.deepEqual((await jsonRequest(remoteBase, "/api/library?scope=public")).payload.questions[0].taxonomyKeys, [pointKey]);
    const unchanged = await jsonRequest(localBase, "/api/publications", { method: "POST", body: { action: "publish-local" } });
    assert.deepEqual(unchanged.payload.knowledgeGraph, { changed: false, version: 2 });

    const forged = await jsonRequest(remoteInternal, "/api/publications", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: {
      action: "knowledge-graph", graph: { graphId: "cn-math-junior", version: 9, hash: "0".repeat(64), document: valid },
    } });
    assert.equal(forged.response.status, 400, "the mirrored document must match its content hash");
    assert.equal((await jsonRequest(remoteInternal, "/api/publications", { method: "POST", headers: { Authorization: "Bearer invalid" }, body: { action: "knowledge-graph", graph: {} } })).response.status, 403);
    assert.equal((await jsonRequest(remoteBase, "/api/knowledge-graph", { cookie: teacher })).payload.graph.version, 2);

    // The course graph: its lessons and modules come from the 课程体系 handouts; the graph keeps domains, mastery and relations.
    const COURSE = "sz-innovation-course";
    const lesson = async (title, sections) => (await jsonRequest(localBase, "/api/handouts", { method: "POST", body: { handout: {
      title, courseUnitId: "course-7-summer", items: sections.map(([id, sectionTitle]) => ({ id, kind: "section", title: sectionTitle, note: "" })),
    } } })).payload.handout;
    const first = await lesson("正负数", [["s1", "正负数与数轴"], ["s2", "绝对值"]]);
    const second = await lesson("有理数运算", [["s3", "加减乘除"]]);
    assert.equal((await jsonRequest(localBase, "/api/knowledge-graph?graph=nope")).response.status, 404);
    assert.equal((await jsonRequest(localBase, "/api/knowledge-graph")).payload.graph.graphId, "cn-math-junior", "no graph named is the 人教版 graph");
    const course = await jsonRequest(localBase, `/api/knowledge-graph?graph=${COURSE}`);
    assert.equal(course.response.status, 200, JSON.stringify(course.payload));
    const courseNode = (document, key) => document.nodes.find((node) => node.key === key);
    assert.deepEqual(["lesson:" + first.id, "module:s1", "module:s2", "lesson:" + second.id, "module:s3"].map((key) => courseNode(course.payload.graph.document, key)?.label),
      ["正负数", "正负数与数轴", "绝对值", "有理数运算", "加减乘除"]);
    assert.deepEqual(course.payload.coverage.handouts["module:s1"], { example: 0, practice: 0, variant: 0, quiz: 0, homework: 0 });
    const courseEditor = await jsonRequest(localBase, `/api/knowledge-graph/draft?graph=${COURSE}`);
    assert.equal(courseEditor.payload.draft, null);
    let courseDraft = updateKnowledgeNode(courseEditor.payload.published.document, "module:s1", { mastery: "能在数轴上表示有理数" });
    courseDraft = addKnowledgeEdge(courseDraft, "module:s1", "module:s3");
    const savedCourse = await jsonRequest(localBase, "/api/knowledge-graph/draft", { method: "PUT", body: { graph: COURSE, revision: courseEditor.payload.revision, document: courseDraft } });
    assert.deepEqual(savedCourse.payload.issues, []);
    const coursePublished = await jsonRequest(localBase, "/api/knowledge-graph/publish", { method: "POST", body: { graph: COURSE, revision: savedCourse.payload.revision, note: "第一批关系" } });
    assert.deepEqual([coursePublished.payload.version, coursePublished.payload.frameworkVersion], [2, `${COURSE}-v2`]);
    assert.equal((await jsonRequest(localBase, "/api/knowledge-graph")).payload.graph.version, 2, "each graph keeps its own versions");
    assert.deepEqual((await jsonRequest(localBase, `/api/knowledge-graph/versions?graph=${COURSE}`)).payload.versions.map((item) => [item.version, item.note]), [[2, "第一批关系"], [1, "课程体系的讲次与知识模块"]]);

    // Renaming a module shows at once; deleting one keeps it as archived history without its relations.
    const renamed = await jsonRequest(localBase, `/api/handouts/${first.id}`, { method: "PUT", body: { handout: { title: "正负数", items: [
      { id: "s1", kind: "section", title: "正负数与数轴表示", note: "" }, { id: "s2", kind: "section", title: "绝对值", note: "" },
    ] } } });
    assert.equal(renamed.response.status, 200);
    await jsonRequest(localBase, `/api/handouts/${second.id}`, { method: "PUT", body: { handout: { title: "有理数运算", items: [{ id: "s4", kind: "section", title: "混合运算", note: "" }] } } });
    const followed = (await jsonRequest(localBase, `/api/knowledge-graph?graph=${COURSE}`)).payload.graph.document;
    assert.equal(courseNode(followed, "module:s1").label, "正负数与数轴表示");
    assert.equal(courseNode(followed, "module:s1").mastery, "能在数轴上表示有理数");
    assert.equal(courseNode(followed, "module:s3").status, "archived");
    assert.equal(courseNode(followed, "module:s4").status, "active");
    assert.deepEqual(followed.edges, []);
  } catch (error) {
    console.error(remote.output(), local?.output());
    throw error;
  } finally {
    if (local) await stopWorker(local);
    await stopWorker(remote);
  }
});
