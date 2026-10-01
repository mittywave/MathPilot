import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loopbackFetch as fetch } from './helpers/loopback-fetch.mjs';

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const CONFIG = join(ROOT, "dist", "server", "wrangler.json");
const TOKEN = "0123456789abcdef0123456789abcdef";
const INVITE = "scoped-e2e-invite";
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

test("scoped libraries isolate accounts, authorize media/downloads, copy independently, and publish atomically", { timeout: 180_000 }, async () => {
  const [localPort, remotePort] = await Promise.all([freePort(), freePort()]);
  const [localState, remoteState] = await Promise.all([
    mkdtemp(join(tmpdir(), "zhiti-scoped-local-")),
    mkdtemp(join(tmpdir(), "zhiti-scoped-remote-")),
  ]);
  for (const state of [localState, remoteState]) {
    command(["d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "--config", join(ROOT, "wrangler.jsonc")]);
  }
  const remote = startWorker(remotePort, remoteState, {
    LOCAL_ADMIN_MODE: "false",
    REGISTRATION_INVITE_CODE: INVITE,
    ADMIN_EMAIL: "admin@scoped.test",
    PUBLIC_LIBRARY_PUBLISH_TOKEN: TOKEN,
  });
  const remoteBase = `http://public.localtest.me:${remotePort}`;
  const remoteInternal = `http://127.0.0.1:${remotePort}`;
  let local;
  try {
    await waitForServer(`${remoteBase}/api/library?scope=public`, remote);
    local = startWorker(localPort, localState, {
      LOCAL_ADMIN_MODE: "true",
      REGISTRATION_INVITE_CODE: INVITE,
      ADMIN_EMAIL: "admin@scoped.test",
      PUBLIC_LIBRARY_PUBLISH_TOKEN: TOKEN,
      PUBLIC_LIBRARY_REMOTE_URL: remoteInternal,
    });
    const localBase = `http://localhost:${localPort}`;
    await waitForServer(`${localBase}/api/auth/me`, local);
    assert.equal((await jsonRequest(localBase, "/api/auth/me")).payload.user?.local, true, "local editor must use a loopback origin");
    const forgedAdmin = await jsonRequest(remoteBase, "/api/auth/me", { headers: { "X-Forwarded-Host": "localhost", "CF-Connecting-IP": "127.0.0.1" } });
    assert.equal(forgedAdmin.payload.user, null, "production mode must reject forged local headers");

    const guestMine = await jsonRequest(remoteBase, "/api/library?scope=mine");
    assert.equal(guestMine.response.status, 401);
    const guestDownload = await jsonRequest(remoteBase, "/api/download", { method: "POST", body: { scope: "public", questionIds: ["missing"] } });
    assert.equal(guestDownload.response.status, 401);

    const registrationOne = await jsonRequest(remoteBase, "/api/auth/register", { method: "POST", body: { email: "one@scoped.test", password: "password123", inviteCode: INVITE } });
    const registrationTwo = await jsonRequest(remoteBase, "/api/auth/register", { method: "POST", body: { email: "two@scoped.test", password: "password123", inviteCode: INVITE } });
    assert.equal(registrationOne.response.status, 201);
    assert.equal(registrationTwo.response.status, 201);
    const userOne = sessionCookie(registrationOne.response);
    const userTwo = sessionCookie(registrationTwo.response);

    assert.equal((await jsonRequest(remoteBase, "/api/students")).response.status, 401);
    const studentOne = await jsonRequest(remoteBase, "/api/students", { cookie: userOne, method: "POST", body: { student: { name: "小宇", className: "初三（2）班", notes: "函数题需要加强" } } });
    const studentTwo = await jsonRequest(remoteBase, "/api/students", { cookie: userTwo, method: "POST", body: { student: { name: "小宇", className: "初三（1）班", notes: "另一个账户" } } });
    assert.equal(studentOne.response.status, 201);
    assert.equal(studentTwo.response.status, 201);
    const studentOneId = studentOne.payload.student.id;
    assert.notEqual(studentOneId, studentTwo.payload.student.id);
    const updatedStudent = await jsonRequest(remoteBase, `/api/students/${studentOneId}`, { cookie: userOne, method: "PUT", body: { student: { name: "小宇", className: "初三（3）班", notes: "档案已更新" } } });
    assert.equal(updatedStudent.payload.student.className, "初三（3）班");
    assert.equal((await jsonRequest(remoteBase, "/api/students", { cookie: userOne })).payload.students[0].notes, "档案已更新");
    assert.equal((await jsonRequest(remoteBase, `/api/students/${studentOneId}/wrong-questions`, { cookie: userTwo })).response.status, 404);

    const emptyOne = await jsonRequest(remoteBase, "/api/library?scope=mine", { cookie: userOne });
    const emptyTwo = await jsonRequest(remoteBase, "/api/library?scope=mine", { cookie: userTwo });
    assert.deepEqual(emptyOne.payload.modules, []);
    assert.deepEqual(emptyTwo.payload.modules, []);

    const moduleOne = await jsonRequest(remoteBase, "/api/modules", { cookie: userOne, method: "POST", body: { scope: "mine", module: { name: "用户一模块", subtitle: "完全隔离" } } });
    assert.equal(moduleOne.response.status, 201);
    const moduleId = moduleOne.payload.module.id;
    const categoryOne = await jsonRequest(remoteBase, "/api/categories", { cookie: userOne, method: "POST", body: { scope: "mine", category: { id: "user-one-category", name: "一级分类", moduleId, parentId: moduleId, createdAt: 1 } } });
    assert.equal(categoryOne.response.status, 201);
    const privateQuestion = await jsonRequest(remoteBase, "/api/questions", { cookie: userOne, method: "POST", body: { scope: "mine", question: question("private-question", moduleId, categoryOne.payload.category.id, "私人公式 x²+1 与表格图片题", true) } });
    assert.equal(privateQuestion.response.status, 201);
    const privateAsset = privateQuestion.payload.question.contentImages[0];

    const firstWrongRecord = await jsonRequest(remoteBase, `/api/students/${studentOneId}/wrong-questions`, { cookie: userOne, method: "POST", body: { scope: "mine", questionIds: ["private-question"], note: "第一次漏看条件" } });
    const repeatedWrongRecord = await jsonRequest(remoteBase, `/api/students/${studentOneId}/wrong-questions`, { cookie: userOne, method: "POST", body: { scope: "mine", questionIds: ["private-question"], note: "第二次仍然算错" } });
    assert.equal(firstWrongRecord.response.status,410);
    assert.equal(repeatedWrongRecord.response.status,410);
    assert.deepEqual((await jsonRequest(remoteBase,`/api/students/${studentOneId}/wrong-questions`,{cookie:userOne})).payload.entries,[]);

    const mineOne = await jsonRequest(remoteBase, "/api/library?scope=mine", { cookie: userOne });
    const mineTwo = await jsonRequest(remoteBase, "/api/library?scope=mine", { cookie: userTwo });
    assert.equal(mineOne.payload.questions.length, 1);
    assert.equal(mineTwo.payload.questions.length, 0);
    assert.equal((await fetch(`${remoteBase}${privateAsset}`)).status, 404);
    assert.equal((await fetch(`${remoteBase}${privateAsset}`, { headers: { Cookie: userTwo } })).status, 404);
    const ownerAsset = await fetch(`${remoteBase}${privateAsset}`, { headers: { Cookie: userOne } });
    assert.equal(ownerAsset.status, 200);
    assert.equal(ownerAsset.headers.get("cache-control"), "private, no-store");
    assert.equal((await jsonRequest(remoteBase, "/api/download", { cookie: userOne, method: "POST", body: { scope: "mine", questionIds: ["private-question"] } })).response.status, 200);
    assert.equal((await jsonRequest(remoteBase, "/api/download", { cookie: userTwo, method: "POST", body: { scope: "mine", questionIds: ["private-question"] } })).response.status, 403);
    assert.equal((await jsonRequest(remoteBase, "/api/modules", { cookie: userOne, method: "POST", body: { scope: "public", module: { name: "非法公共写入", subtitle: "" } } })).response.status, 403);

    const localMe = await jsonRequest(localBase, "/api/auth/me");
    assert.equal(localMe.payload.user.local, true);
    const localLibrary = await jsonRequest(localBase, "/api/library?scope=public");
    const publicModule = localLibrary.payload.modules[0].id;
    const publicCategory = localLibrary.payload.categories.find((item) => item.moduleId === publicModule).id;
    const savedPublic = await jsonRequest(localBase, "/api/questions", { method: "POST", body: { scope: "public", question: question("public-question", publicModule, publicCategory, "公共公式 x²+1 与表格图片题", true) } });
    assert.equal(savedPublic.response.status, 201);

    const firstPublish = await jsonRequest(localBase, "/api/publications", { method: "POST", body: { action: "publish-local" } });
    assert.equal(firstPublish.response.status, 200);
    assert.equal(firstPublish.payload.diff.questions.added, 1);
    const unchangedPublish = await jsonRequest(localBase, "/api/publications", { method: "POST", body: { action: "publish-local" } });
    assert.deepEqual(unchangedPublish.payload.diff.questions, { added: 0, updated: 0, deleted: 0 });

    const publicLibrary = await jsonRequest(remoteBase, "/api/library?scope=public");
    assert.equal(publicLibrary.payload.questions.length, 1);
    const publicAsset = publicLibrary.payload.questions[0].contentImages[0];
    const guestPublicAsset = await fetch(`${remoteBase}${publicAsset}`);
    assert.equal(guestPublicAsset.status, 200);
    assert.equal(guestPublicAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const publicWrongRecord = await jsonRequest(remoteBase, `/api/students/${studentOneId}/wrong-questions`, { cookie: userOne, method: "POST", body: { scope: "public", questionIds: ["public-question"], note: "公共题错因" } });
    assert.equal(publicWrongRecord.response.status,410);
    const studentSummary=await jsonRequest(remoteBase,"/api/students",{cookie:userOne});
    assert.equal(studentSummary.payload.students[0].wrongCount,0);
    assert.equal(studentSummary.payload.students[0].reviewingCount,0);
    assert.equal(studentSummary.payload.students[0].masteredCount,0);

    const copied = await jsonRequest(remoteBase, "/api/library/copy", { cookie: userOne, method: "POST", body: { questionIds: ["public-question"], targetModuleId: moduleId, targetCategoryId: categoryOne.payload.category.id } });
    assert.equal(copied.payload.copied, 1);
    const copiedQuestion = copied.payload.questions[0];
    assert.notEqual(copiedQuestion.id, "public-question");
    const updatedCopy = { ...copiedQuestion, stem: "私人副本已修改", analysis: "私人解析" };
    assert.equal((await jsonRequest(remoteBase, `/api/questions/${copiedQuestion.id}`, { cookie: userOne, method: "PUT", body: { scope: "mine", question: updatedCopy } })).response.status, 200);
    assert.equal((await jsonRequest(remoteBase, "/api/library?scope=public")).payload.questions[0].stem, "公共公式 x²+1 与表格图片题");

    const tempModule = await jsonRequest(remoteBase, "/api/modules", { cookie: userOne, method: "POST", body: { scope: "mine", module: { name: "待删模块", subtitle: "排序测试" } } });
    const tempId = tempModule.payload.module.id;
    await jsonRequest(remoteBase, "/api/categories", { cookie: userOne, method: "POST", body: { scope: "mine", category: { id: "temp-category", name: "待删分类", moduleId: tempId, parentId: tempId, createdAt: 1 } } });
    await jsonRequest(remoteBase, "/api/questions", { cookie: userOne, method: "POST", body: { scope: "mine", question: question("temp-question", tempId, "temp-category", "待删除题") } });
    assert.equal((await jsonRequest(remoteBase, "/api/modules", { cookie: userOne, method: "POST", body: { scope: "mine", order: [tempId, moduleId] } })).response.status, 200);
    assert.equal((await jsonRequest(remoteBase, `/api/modules/${tempId}`, { cookie: userOne, method: "DELETE", body: { scope: "mine", confirmation: "错误名称" } })).response.status, 400);
    const deletedModule = await jsonRequest(remoteBase, `/api/modules/${tempId}`, { cookie: userOne, method: "DELETE", body: { scope: "mine", confirmation: "待删模块" } });
    assert.deepEqual({ questions: deletedModule.payload.questionCount, categories: deletedModule.payload.categoryCount }, { questions: 1, categories: 1 });
    assert.equal((await jsonRequest(remoteBase, "/api/library?scope=mine", { cookie: userOne })).payload.modules[0].sortOrder, 0);

    assert.equal((await jsonRequest(remoteInternal, "/api/publications", { method: "POST", headers: { Authorization: "Bearer invalid" }, body: { action: "begin", manifest: { modules: [], categories: [], questions: [], assets: [] } } })).response.status, 403);
    const beginFailure = await jsonRequest(remoteInternal, "/api/publications", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: { action: "begin", manifest: { modules: [], categories: [], questions: [], assets: [] } } });
    assert.equal(beginFailure.response.status, 200);
    const failedCommit = await jsonRequest(remoteInternal, "/api/publications", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: { action: "commit", publicationId: beginFailure.payload.publicationId, manifest: { modules: [{ id: "changed", hash: "a".repeat(64) }], categories: [], questions: [], assets: [] }, changes: { modules: [], categories: [], questions: [] } } });
    assert.equal(failedCommit.response.status, 409);
    assert.equal((await jsonRequest(remoteBase, "/api/library?scope=public")).payload.questions.length, 1);

    assert.equal((await jsonRequest(localBase, "/api/questions/public-question?scope=public", { method: "DELETE", body: {} })).response.status, 200);
    const deletionPublish = await jsonRequest(localBase, "/api/publications", { method: "POST", body: { action: "publish-local" } });
    assert.equal(deletionPublish.payload.diff.questions.deleted, 1);
    assert.equal((await jsonRequest(remoteBase, "/api/library?scope=public")).payload.questions.length, 0);
    const wrongBookAfterSourceDeletion = await jsonRequest(remoteBase, `/api/students/${studentOneId}/wrong-questions`, { cookie: userOne });
    assert.equal(wrongBookAfterSourceDeletion.payload.entries.length, 0);
    assert.equal((await fetch(`${remoteBase}${publicAsset}`, { headers: { Cookie: userOne } })).status, 200);
    const privateAfterDeletion = await jsonRequest(remoteBase, "/api/library?scope=mine", { cookie: userOne });
    assert.equal(privateAfterDeletion.payload.questions.find((item) => item.id === copiedQuestion.id).stem, "私人副本已修改");
    assert.equal((await fetch(`${remoteBase}${copiedQuestion.contentImages[0]}`, { headers: { Cookie: userOne } })).status, 200);
    const removedStudent = await jsonRequest(remoteBase, `/api/students/${studentOneId}`, { cookie: userOne, method: "DELETE", body: {} });
    assert.equal(removedStudent.payload.wrongQuestionCount, 0);
    assert.equal((await jsonRequest(remoteBase, "/api/students", { cookie: userOne })).payload.students.length, 0);
  } catch (error) {
    console.error(remote.output(), local?.output());
    throw error;
  } finally {
    if (local) await stopWorker(local);
    await stopWorker(remote);
  }
});
