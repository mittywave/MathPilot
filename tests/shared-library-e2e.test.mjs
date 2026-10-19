import assert from "node:assert/strict";
import { bootstrapAdmin } from "./helpers/migrated-d1.mjs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loopbackFetch as fetch } from './helpers/loopback-fetch.mjs';

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const CONFIG = join(ROOT, "dist", "server", "wrangler.json");
const INVITE = "shared-e2e-invite";
const PUBLISH_TOKEN = "synthetic-shared-library-publication-token";
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function command(args) {
  const result = spawnSync(WRANGLER, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function startWorker(port, persistTo, vars) {
  const args = [join(ROOT, "scripts/start-local-test-worker.mjs"), CONFIG, String(port), persistTo, JSON.stringify(vars)];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForServer(url, worker) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (worker.child.exitCode != null) throw new Error(`Worker 提前退出\n${worker.output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* 等待监听端口 */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  throw new Error(`Worker 启动超时\n${worker.output()}`);
}

async function stopWorker(worker) {
  if (worker.child.exitCode != null) return;
  worker.child.kill("SIGINT");
  await Promise.race([
    new Promise((resolveExit) => worker.child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (worker.child.exitCode == null) worker.child.kill("SIGKILL");
}

async function jsonRequest(base, path, { cookie = "", method = "GET", body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders.Cookie = cookie;
  if (body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    requestHeaders.Origin = base;
  }
  const response = await fetch(`${base}${path}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function sessionCookie(response) {
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

function question(id, moduleId, categoryId, stem, image = false) {
  return {
    id, moduleId, categoryId, type: "解答题", difficulty: "中等", provenance: "来源待核实",
    stem, stemDocxXml: ["<w:p><w:r><w:t>结构化题干</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"],
    options: [], answer: "2", analysis: "因为 x=1，所以 x²+1=2。", source: "双实例回归",
    contentImages: image ? [PIXEL] : [], createdAt: 1, updatedAt: 1,
  };
}

test("one shared library: every teacher reads and edits it, only administrators delete", { timeout: 180_000 }, async () => {
  const port = await freePort();
  const state = await mkdtemp(join(tmpdir(), "zhiti-shared-"));
  command(["d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "--config", join(ROOT, "wrangler.jsonc")]);
  const worker = startWorker(port, state, { LOCAL_ADMIN_MODE: "false", REGISTRATION_INVITE_CODE: INVITE, ADMIN_EMAIL: "admin@shared.test", PUBLIC_LIBRARY_PUBLISH_TOKEN: PUBLISH_TOKEN });
  const base = `http://public.localtest.me:${port}`;
  try {
    await waitForServer(`${base}/api/library`, worker);
    const forgedAdmin = await jsonRequest(base, "/api/auth/me", { headers: { "X-Forwarded-Host": "localhost", "CF-Connecting-IP": "127.0.0.1" } });
    assert.equal(forgedAdmin.payload.user, null, "production mode must reject forged local headers");

    assert.equal((await jsonRequest(base, "/api/library")).response.status, 200, "guests can still browse");
    assert.equal((await jsonRequest(base, "/api/download", { method: "POST", body: { questionIds: ["missing"] } })).response.status, 401);
    assert.equal((await jsonRequest(base, "/api/modules", { method: "POST", body: { module: { name: "访客写入", subtitle: "" } } })).response.status, 401);

    const cookies = {};
    for (const name of ["one", "two", "admin"]) {
      const registration = await jsonRequest(base, "/api/auth/register", { method: "POST", body: { email: `${name}@shared.test`, password: "password123", inviteCode: INVITE } });
      assert.equal(registration.response.status, 201);
      assert.equal(registration.payload.user.role, "member");
      if (name === "admin") bootstrapAdmin(state, registration.payload.user.id);
      const setCookie = registration.response.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /HttpOnly; SameSite=Lax/);
      assert.doesNotMatch(setCookie, /;\s*Secure\b/i, "browsers drop Secure cookies over the plain-http LAN address");
      cookies[name] = sessionCookie(registration.response);
    }
    const { one, two, admin } = cookies;

    // Students stay with the teacher who created them.
    const studentOne = await jsonRequest(base, "/api/students", { cookie: one, method: "POST", body: { student: { name: "小宇", className: "初三（2）班", notes: "" } } });
    assert.equal(studentOne.response.status, 201);
    assert.equal((await jsonRequest(base, `/api/students/${studentOne.payload.student.id}/wrong-questions`, { cookie: two })).response.status, 404);
    assert.deepEqual((await jsonRequest(base, "/api/students", { cookie: two })).payload.students, []);

    const createdModule = await jsonRequest(base, "/api/modules", { cookie: one, method: "POST", body: { module: { name: "初二几何", subtitle: "共用" } } });
    assert.equal(createdModule.response.status, 201);
    const moduleId = createdModule.payload.module.id;
    const category = await jsonRequest(base, "/api/categories", { cookie: one, method: "POST", body: { category: { id: "shared-category", name: "平行四边形", moduleId, parentId: moduleId, createdAt: 1 } } });
    assert.equal(category.response.status, 201);
    const saved = await jsonRequest(base, "/api/questions", { cookie: one, method: "POST", body: { question: question("shared-question", moduleId, "shared-category", "公式 x²+1 与表格图片题", true) } });
    assert.equal(saved.response.status, 201);
    const firstCode = saved.payload.question.code;
    assert.match(firstCode, /^\d{4}$/);
    const asset = saved.payload.question.contentImages[0];
    const retry = await jsonRequest(base, "/api/questions", { cookie: one, method: "POST", body: { question: question("shared-question", moduleId, "shared-category", "公式 x²+1 与表格图片题", true) } });
    assert.equal(retry.response.status, 201, "retry after a lost response must return the already saved question");
    assert.equal(retry.payload.question.code, firstCode);
    assert.equal(retry.payload.question.updatedAt, saved.payload.question.updatedAt);
    assert.equal((await jsonRequest(base, "/api/questions", { cookie: one, method: "POST", body: { question: question("shared-question", moduleId, "shared-category", "不应覆盖原题", true) } })).response.status, 409);

    const concurrentBody = { question: question("concurrent-import-question", moduleId, "shared-category", "并发创建同一道配图题", true) };
    const freshImage = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M1 1L19 19" stroke="black"/></svg>').toString('base64')}`;
    concurrentBody.question.contentImages = [freshImage, freshImage];
    concurrentBody.question.stemDocxAssets = { rId1: { dataUrl: freshImage, contentType: "image/svg+xml" } };
    const concurrentCreates = await Promise.all(Array.from({ length: 3 }, () => jsonRequest(base, "/api/questions", { cookie: one, method: "POST", body: concurrentBody })));
    assert.deepEqual(concurrentCreates.map(x => x.response.status), [201, 201, 201]);
    const concurrentCode = concurrentCreates[0].payload.question.code;
    assert.notEqual(concurrentCode, firstCode);
    assert.ok(concurrentCreates.every(x => x.payload.question.code === concurrentCode));
    const sharedImage = concurrentCreates[0].payload.question.contentImages[0];
    assert.ok(concurrentCreates.every(x => x.payload.question.contentImages.every(url => url === sharedImage)), "all repeated image references must reuse one complete asset");
    const storedImage = await fetch(`${base}${sharedImage}`, { headers: { Cookie: two } });
    assert.equal(storedImage.status, 200);
    assert.equal(await storedImage.text(), Buffer.from(freshImage.split(",")[1], "base64").toString(), "deduplicated asset must contain every original byte");

    // The second teacher sees, uses and edits the first teacher's work.
    const seenByTwo = await jsonRequest(base, "/api/library", { cookie: two });
    const sharedQuestion = seenByTwo.payload.questions.find((item) => item.id === "shared-question");
    assert.equal(seenByTwo.payload.scope, "public");
    assert.ok(seenByTwo.payload.modules.some((item) => item.id === moduleId));
    assert.equal(sharedQuestion.canEdit, true);
    assert.equal(sharedQuestion.createdByEmail, "one@shared.test");
    assert.equal((await jsonRequest(base, "/api/library?scope=mine", { cookie: two })).payload.questions.length, seenByTwo.payload.questions.length, "the legacy scope parameter reads the same library");
    // A browser revalidates its copy of the library: the same copy is answered 304, a changed one in full.
    const libraryTag = seenByTwo.response.headers.get("etag");
    assert.match(libraryTag ?? "", /^"[0-9a-f]{64}"$/);
    assert.equal(seenByTwo.response.headers.get("cache-control"), "private, no-cache");
    assert.equal((await fetch(`${base}/api/library`, { headers: { Cookie: two, "If-None-Match": libraryTag } })).status, 304, "an unchanged library is not sent again");
    assert.equal((await fetch(`${base}${asset}`, { headers: { Cookie: two } })).status, 200);
    assert.equal((await jsonRequest(base, "/api/download", { cookie: two, method: "POST", body: { questionIds: ["shared-question"] } })).response.status, 200);
    const edited = await jsonRequest(base, "/api/questions/shared-question", { cookie: two, method: "PUT", body: { question: { ...sharedQuestion, code: "9999", stem: "第二位老师修改后的题干" } } });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.payload.question.code, firstCode, "client cannot reassign a code");
    const revalidated = await fetch(`${base}/api/library`, { headers: { Cookie: two, "If-None-Match": libraryTag } });
    assert.equal(revalidated.status, 200, "an edited library is sent again in full");
    assert.notEqual(revalidated.headers.get("etag"), libraryTag);
    assert.equal((await revalidated.json()).questions.find((item) => item.id === "shared-question").stem, "第二位老师修改后的题干");
    assert.equal((await jsonRequest(base, "/api/library", { cookie: one })).payload.questions.find((item) => item.id === "shared-question").stem, "第二位老师修改后的题干");
    const second = await jsonRequest(base, "/api/modules", { cookie: two, method: "POST", body: { module: { name: "待删模块", subtitle: "" } } });
    const tempId = second.payload.module.id;
    await jsonRequest(base, "/api/categories", { cookie: two, method: "POST", body: { category: { id: "temp-category", name: "待删分类", moduleId: tempId, parentId: tempId, createdAt: 1 } } });
    await jsonRequest(base, "/api/questions", { cookie: two, method: "POST", body: { question: question("temp-question", tempId, "temp-category", "待删除题") } });
    const order = (await jsonRequest(base, "/api/library", { cookie: two })).payload.modules.map((item) => item.id).filter((id) => id !== tempId);
    assert.equal((await jsonRequest(base, "/api/modules", { cookie: two, method: "POST", body: { order: [tempId, ...order] } })).response.status, 200);

    // A move can reorder siblings or reparent a whole branch without changing questions.
    for (const [id, parentId] of [["shared-peer", moduleId], ["shared-peer-two", moduleId], ["shared-child-a", "shared-category"], ["shared-child-b", "shared-category"], ["shared-grandchild", "shared-child-a"], ["race-a", moduleId], ["race-b", moduleId]]) {
      assert.equal((await jsonRequest(base, "/api/categories", { cookie: one, method: "POST", body: { category: { id, name: id, moduleId, parentId, createdAt: 1 } } })).response.status, 201);
    }
    assert.equal((await jsonRequest(base, "/api/questions", { cookie: one, method: "POST", body: { question: question("branch-question", moduleId, "shared-grandchild", "子分类里的题目") } })).response.status, 201);
    const beforeSort = await jsonRequest(base, "/api/library", { cookie: one });
    const move = (id, parentId, beforeId = null, cookie = two) => jsonRequest(base, "/api/categories", { cookie, method: "POST", body: { move: { id, parentId, beforeId } } });
    assert.equal((await move("shared-peer", moduleId, "shared-category", "")).response.status, 401);
    assert.equal((await move("shared-peer", moduleId, "shared-category")).response.status, 200, "another teacher can move shared categories");
    command(["d1", "execute", "DB", "--local", "--persist-to", state, "--config", join(ROOT, "wrangler.jsonc"), "--command", "UPDATE library_categories_v2 SET sort_order=0 WHERE source_id IN ('shared-child-a','shared-child-b')"]);
    assert.equal((await move("shared-child-b", "shared-category", "shared-child-a")).response.status, 200, "tied legacy ranks can still be ordered");
    const sorted = await jsonRequest(base, "/api/library", { cookie: one });
    assert.deepEqual(sorted.payload.categories.filter(item => item.moduleId === moduleId && item.parentId === moduleId).map(item => item.id), ["shared-peer", "shared-category", "shared-peer-two", "race-a", "race-b"]);
    assert.deepEqual(sorted.payload.categories.filter(item => item.parentId === "shared-category").map(item => item.id), ["shared-child-b", "shared-child-a"]);
    assert.deepEqual([...sorted.payload.categories].sort((a, b) => a.id.localeCompare(b.id)), [...beforeSort.payload.categories].sort((a, b) => a.id.localeCompare(b.id)));
    assert.notEqual(sorted.response.headers.get("etag"), beforeSort.response.headers.get("etag"));

    assert.equal((await move("shared-child-a", "shared-peer")).response.status, 200, "move a parent with its descendants into a different category");
    const reparented = (await jsonRequest(base, "/api/library", { cookie: one })).payload;
    assert.equal(reparented.categories.find(item => item.id === "shared-child-a").parentId, "shared-peer");
    assert.equal(reparented.categories.find(item => item.id === "shared-grandchild").parentId, "shared-child-a");
    assert.deepEqual(reparented.questions, beforeSort.payload.questions, "every question, image, ID and category reference stays intact");
    for (const [id, parentId, beforeId, status] of [
      ["shared-peer", "shared-peer", null, 400], ["shared-peer", "shared-grandchild", null, 400],
      ["shared-child-b", "missing", null, 400], ["shared-child-b", tempId, null, 400],
      ["shared-child-b", "temp-category", null, 400], ["missing", moduleId, null, 404],
      ["shared-child-b", "shared-peer", "missing", 409], ["shared-child-b", "shared-peer", "temp-category", 409],
    ]) assert.equal((await move(id, parentId, beforeId)).response.status, status);
    assert.deepEqual((await jsonRequest(base, "/api/library", { cookie: one })).payload.categories, reparented.categories, "invalid moves never partially change the directory");
    assert.equal((await move("shared-child-a", moduleId, "shared-category")).response.status, 200, "a branch can return to the module root");
    const detached = (await jsonRequest(base, "/api/library", { cookie: one })).payload;
    assert.equal(detached.categories.find(item => item.id === "shared-child-a").parentId, moduleId);
    assert.equal(detached.categories.find(item => item.id === "shared-grandchild").parentId, "shared-child-a");

    const competing = await Promise.all([move("race-a", "race-b"), move("race-b", "race-a")]);
    assert.equal(competing.filter(result => result.response.status === 200).length, 1, "only one of two mutually cyclic concurrent moves can commit");
    assert.ok(competing.every(result => [200, 400, 409].includes(result.response.status)));
    const raced = (await jsonRequest(base, "/api/library", { cookie: one })).payload;
    for (const node of raced.categories) {
      const ancestors = new Set([node.id]); let parent = raced.categories.find(item => item.id === node.parentId);
      while (parent) { assert.equal(ancestors.has(parent.id), false, "the directory has no cycles"); ancestors.add(parent.id); parent = raced.categories.find(item => item.id === parent.parentId); }
    }
    assert.deepEqual(raced.questions, beforeSort.payload.questions);

    // Deleting is reserved for administrators.
    assert.equal((await jsonRequest(base, "/api/questions/shared-question", { cookie: two, method: "DELETE" })).response.status, 403);
    assert.equal((await jsonRequest(base, "/api/categories/shared-category", { cookie: one, method: "DELETE" })).response.status, 403);
    assert.equal((await jsonRequest(base, `/api/modules/${tempId}`, { cookie: two, method: "DELETE", body: { confirmation: "待删模块" } })).response.status, 403);
    assert.equal((await jsonRequest(base, "/api/questions/concurrent-import-question", { cookie: admin, method: "DELETE" })).response.status, 200);
    // A deleted question waits in the recycle bin, which only administrators open, and comes back unchanged.
    assert.equal((await jsonRequest(base, "/api/questions", { cookie: two })).response.status, 403);
    assert.equal((await jsonRequest(base, "/api/questions", { cookie: admin })).payload.questions[0].code, concurrentCode);
    assert.deepEqual((await jsonRequest(base, "/api/questions", { cookie: admin })).payload.questions.map((item) => item.id), ["concurrent-import-question"]);
    assert.equal((await jsonRequest(base, "/api/library", { cookie: one })).payload.questions.some((item) => item.id === "concurrent-import-question"), false);
    assert.equal((await jsonRequest(base, "/api/questions/concurrent-import-question", { cookie: two, method: "PATCH" })).response.status, 403);
    assert.equal((await jsonRequest(base, "/api/questions/concurrent-import-question", { cookie: admin, method: "PATCH" })).response.status, 200);
    assert.equal((await jsonRequest(base, "/api/library", { cookie: one })).payload.questions.some((item) => item.id === "concurrent-import-question"), true);
    assert.equal((await jsonRequest(base, "/api/library", { cookie: one })).payload.questions.find(q => q.id === "concurrent-import-question").code, concurrentCode);
    assert.deepEqual((await jsonRequest(base, "/api/questions", { cookie: admin })).payload.questions, []);
    assert.equal((await jsonRequest(base, "/api/questions/concurrent-import-question", { cookie: admin, method: "DELETE" })).response.status, 200);
    assert.equal((await jsonRequest(base, `/api/modules/${tempId}`, { cookie: admin, method: "DELETE", body: { confirmation: "错误名称" } })).response.status, 400);
    const deletedModule = await jsonRequest(base, `/api/modules/${tempId}`, { cookie: admin, method: "DELETE", body: { confirmation: "待删模块" } });
    assert.deepEqual({ questions: deletedModule.payload.questionCount, categories: deletedModule.payload.categoryCount }, { questions: 1, categories: 1 });
    const after = await jsonRequest(base, "/api/library", { cookie: one });
    assert.deepEqual(after.payload.questions.map((item) => item.id).sort(), ["branch-question", "shared-question"]);
    assert.deepEqual(after.payload.modules.map((item) => item.sortOrder), after.payload.modules.map((_, index) => index), "module order closes the gap");

    // Handouts are shared the same way.
    const handout = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "第1讲", items: [{ id: "i1", kind: "question", scope: "public", questionId: "shared-question" }], courseUnitId: "course-8-autumn" } } });
    assert.equal(handout.response.status, 201);
    const handoutId = handout.payload.handout.id;
    assert.deepEqual((await jsonRequest(base, "/api/handouts", { cookie: two })).payload.handouts.map((item) => item.id), [handoutId]);
    assert.equal((await jsonRequest(base, `/api/handouts/${handoutId}`, { cookie: two, method: "PUT", body: { handout: { title: "第1讲 平行四边形", items: [] } } })).response.status, 200);
    assert.equal((await jsonRequest(base, `/api/handouts/${handoutId}`, { cookie: one })).payload.handout.title, "第1讲 平行四边形");
    assert.equal((await jsonRequest(base, `/api/handouts/${handoutId}`, { cookie: two, method: "DELETE", body: {} })).response.status, 403);
    assert.equal((await jsonRequest(base, `/api/handouts/${handoutId}`, { cookie: admin, method: "DELETE", body: {} })).response.status, 200);

    // Exercise the real Worker/D1 publisher, including more assets than D1's 100-parameter limit.
    const assets = Array.from({ length: 173 }, (_, index) => {
      const bytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><title>Fixture ${index}</title><rect width="1" height="1"/></svg>`);
      return { hash: createHash("sha256").update(bytes).digest("hex"), contentType: "image/svg+xml", byteSize: bytes.length, base64: bytes.toString("base64") };
    });
    const publish = body => jsonRequest(base, "/api/publications", { method: "POST", body, headers: { Authorization: `Bearer ${PUBLISH_TOKEN}` } });
    for (const count of [100, 101, 173]) {
      const selected = assets.slice(0, count);
      const manifest = { modules: [], categories: [], questions: [], assets: selected.map(({ hash, contentType, byteSize }) => ({ hash, contentType, byteSize })) };
      const begun = await publish({ action: "begin", manifest });
      assert.equal(begun.response.status, 200, JSON.stringify(begun.payload));
      const publicationId = begun.payload.publicationId;
      const rejected = await jsonRequest(base, "/api/publications", { method: "POST", body: { action: "fail", publicationId }, headers: { Authorization: "Bearer wrong-synthetic-token" } });
      assert.equal(rejected.response.status, 403);
      for (const hash of begun.payload.missingAssetHashes) {
        const uploaded = await publish({ action: "asset", publicationId, ...selected.find(asset => asset.hash === hash) });
        assert.equal(uploaded.response.status, 200, "a rejected request must leave the legitimate staging publication usable");
      }
      const committed = await publish({ action: "commit", publicationId, manifest, changes: { modules: [], categories: [], questions: [] } });
      assert.equal(committed.response.status, 200, JSON.stringify(committed.payload));
      assert.ok(committed.payload.publishedAt);
    }
    const failed = await publish({ action: "begin", manifest: { modules: [], categories: [], questions: [], assets: [] } });
    assert.equal((await publish({ action: "fail", publicationId: failed.payload.publicationId })).response.status, 200, "authorized failure cleanup is retained");
  } catch (error) {
    console.error(worker.output());
    throw error;
  } finally {
    await stopWorker(worker);
  }
});
