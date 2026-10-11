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
const INVITE = "handouts-e2e-invite";

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

async function jsonRequest(base, path, { cookie = "", method = "GET", body, origin = base } = {}) {
  const headers = cookie ? { Cookie: cookie } : {};
  if (body !== undefined) Object.assign(headers, { "Content-Type": "application/json", Origin: origin });
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, payload: await response.json().catch(() => ({})) };
}

test("course and topic handouts are shared, student handouts stay with the student's teacher", { timeout: 120_000 }, async () => {
  const port = await freePort();
  const state = await mkdtemp(join(tmpdir(), "zhiti-handouts-"));
  const migrate = spawnSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "--config", join(ROOT, "wrangler.jsonc")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (migrate.status !== 0) throw new Error(`${migrate.stdout}\n${migrate.stderr}`);
  const vars = { LOCAL_ADMIN_MODE: "false", REGISTRATION_INVITE_CODE: INVITE, ADMIN_EMAIL: "admin@handouts.test" };
  const worker = spawn(process.execPath, [join(ROOT, "scripts/start-local-test-worker.mjs"), CONFIG, String(port), state, JSON.stringify(vars)], { cwd: ROOT, env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; worker.stdout.on("data", (chunk) => { output += chunk; }); worker.stderr.on("data", (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let ready = false, deadline = Date.now() + 30_000; !ready;) {
      if (worker.exitCode != null || Date.now() > deadline) throw new Error(`Worker 未能启动\n${output}`);
      try { ready = (await fetch(`${base}/api/auth/me`)).ok; } catch { /* 等待监听端口 */ }
      if (!ready) await new Promise((wait) => setTimeout(wait, 120));
    }
    assert.equal((await jsonRequest(base, "/api/handouts")).response.status, 401);
    const cookies = [];
    for (const email of ["one@handouts.test", "two@handouts.test", "admin@handouts.test"]) {
      const registration = await jsonRequest(base, "/api/auth/register", { method: "POST", body: { email, password: "password123", inviteCode: INVITE } });
      assert.equal(registration.response.status, 201);
      cookies.push((registration.response.headers.get("set-cookie") ?? "").split(";", 1)[0]);
    }
    const [one, two, admin] = cookies;

    const created = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "  ", items: [
      { id: "s1", kind: "section", title: "一、知识梳理", note: "$\\frac{1}{2}$" },
      { id: "q1", kind: "question", scope: "mine", questionId: "q-a" },
      { id: "bad", kind: "question", scope: "everyone", questionId: "q-b" },
      { id: "q2", kind: "question", scope: "public", questionId: "q-c", band: "variant" },
    ] } } });
    assert.equal(created.response.status, 201);
    const handout = created.payload.handout;
    assert.equal(handout.title, "未命名讲义");
    assert.deepEqual(handout.items.map((item) => item.id), ["s1", "q1", "q2"]);
    assert.deepEqual(handout.items.slice(1).map((item) => item.band), ["example", "variant"], "a missing band is stored as 例题");

    const forged = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "x" } }, origin: "http://evil.test" });
    assert.equal(forged.response.status, 403);

    // 小测 and 作业 questions are stored after the 讲义; one naming a module that is gone tests the first module.
    const reordered = [handout.items[2], { id: "t1", kind: "quiz", scope: "public", questionId: "q-d", moduleId: "s1" }, handout.items[0], { ...handout.items[1], band: "practice" },
      { id: "h1", kind: "homework", scope: "public", questionId: "q-e", moduleId: "gone" }];
    const updated = await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: one, method: "PUT", body: { handout: { title: "第3讲 一元一次方程", items: reordered } } });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.handout.createdAt, handout.createdAt);
    const fetched = await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: one });
    assert.equal(fetched.payload.handout.title, "第3讲 一元一次方程");
    assert.deepEqual(fetched.payload.handout.items.map((item) => item.id), ["q2", "s1", "q1", "t1", "h1"]);
    assert.equal(fetched.payload.handout.items[1].note, "$\\frac{1}{2}$");
    assert.deepEqual(fetched.payload.handout.items.map((item) => item.band), ["variant", undefined, "practice", undefined, undefined], "bands persist through save and reload");
    assert.deepEqual(fetched.payload.handout.items.slice(3).map((item) => [item.kind, item.moduleId]), [["quiz", "s1"], ["homework", "s1"]]);
    const list = await jsonRequest(base, "/api/handouts", { cookie: one });
    assert.deepEqual(list.payload.handouts.map((item) => [item.title, item.outline]), [["第3讲 一元一次方程", [{ title: "", questionIds: ["q-c"] }, { title: "一、知识梳理", questionIds: ["q-a"] }]]], "the list outlines modules and their question references");
    assert.equal(list.payload.handouts[0].items, undefined, "the list carries summaries only");
    assert.deepEqual(list.payload.handouts[0].sheetCounts, { quiz: 1, homework: 1 }, "the list counts the 小测 and 作业 questions");

    // 机构版：其他老师能看到并打开同一份讲义，但只有管理员能删除。
    assert.equal((await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: two })).payload.handout.title, "第3讲 一元一次方程");
    assert.deepEqual((await jsonRequest(base, "/api/handouts", { cookie: two })).payload.handouts.map((item) => item.id), [handout.id]);
    assert.equal((await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: two, method: "DELETE", body: {} })).response.status, 403);

    // Figures recognised from knowledge screenshots are stored as the owner's own assets.
    const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const uploaded = await jsonRequest(base, "/api/handout-images", { cookie: one, method: "POST", body: { image: pixel } });
    assert.equal(uploaded.response.status, 201);
    assert.match(uploaded.payload.url, /^\/api\/assets\/[0-9a-f-]{36}$/);
    assert.equal((await fetch(`${base}${uploaded.payload.url}`, { headers: { Cookie: one } })).status, 200);
    assert.equal((await fetch(`${base}${uploaded.payload.url}`, { headers: { Cookie: two } })).status, 200, "figures belong to the shared library");
    assert.equal((await jsonRequest(base, "/api/handout-images", { cookie: one, method: "POST", body: { image: "data:text/html;base64,PGI+" } })).response.status, 400);
    assert.equal((await jsonRequest(base, "/api/handout-images", { method: "POST", body: { image: pixel } })).response.status, 401);
    assert.equal((await jsonRequest(base, "/api/recognize-note", { cookie: one, method: "POST", body: {} })).response.status, 400);

    // 课次: handouts created in a term append to it; arrange sets one term's order and can move a handout in.
    assert.deepEqual([list.payload.handouts[0].grade, list.payload.handouts[0].term, list.payload.handouts[0].domain, list.payload.handouts[0].studentId], [null, null, null, null], "a handout created without a place waits in the unsorted topics");
    const term = { grade: 8, term: "autumn" };
    const lessonIds = [];
    for (const title of ["第一讲", "第二讲"]) {
      const lesson = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title, items: [], ...term } } });
      assert.equal(lesson.response.status, 201);
      assert.deepEqual([lesson.payload.handout.grade, lesson.payload.handout.term, lesson.payload.handout.position], [8, "autumn", lessonIds.length]);
      lessonIds.push(lesson.payload.handout.id);
    }
    const otherTerm = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "寒假第一讲", items: [], grade: 8, term: "winter" } } });
    assert.equal(otherTerm.payload.handout.position, 0, "each term numbers its own 课次");
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { grade: 8, term: "fall", ids: lessonIds } })).response.status, 400);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { ...term, ids: lessonIds }, origin: "http://evil.test" })).response.status, 403);
    const arranged = await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { ...term, ids: [lessonIds[1], handout.id, lessonIds[0]] } });
    assert.equal(arranged.response.status, 200);
    const autumn = (await jsonRequest(base, "/api/handouts", { cookie: two })).payload.handouts.filter((item) => item.grade === 8 && item.term === "autumn");
    assert.deepEqual(autumn.map((item) => item.title), ["第二讲", "第3讲 一元一次方程", "第一讲"], "every teacher sees the same 课次 order");
    const saved = await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: one, method: "PUT", body: { handout: { title: "第3讲 一元一次方程", items: reordered } } });
    assert.deepEqual([saved.payload.handout.grade, saved.payload.handout.term, saved.payload.handout.position], [8, "autumn", 1], "saving content keeps the placement");

    // 专题库: topics sit in one of five domains, number within it and can be reordered.
    const topicIds = [];
    for (const title of ["一次函数的折叠问题", "一次函数中的规律问题"]) {
      const topic = await jsonRequest(base, "/api/handouts", { cookie: two, method: "POST", body: { handout: { title, items: [], domain: "function" } } });
      assert.equal(topic.response.status, 201);
      assert.deepEqual([topic.payload.handout.domain, topic.payload.handout.grade, topic.payload.handout.term, topic.payload.handout.position], ["function", null, null, topicIds.length]);
      topicIds.push(topic.payload.handout.id);
    }
    const geometry = await jsonRequest(base, "/api/handouts", { cookie: two, method: "POST", body: { handout: { title: "几何最值", items: [], domain: "geometry" } } });
    assert.equal(geometry.payload.handout.position, 0, "each domain numbers its own topics");
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "x", items: [], domain: "physics" } } })).response.status, 400, "an unknown domain is refused");
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "x", items: [], grade: 8 } } })).response.status, 400, "a grade without a term is refused");
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { domain: "function", ids: [topicIds[1], topicIds[0]] } })).response.status, 200);
    const topics = (await jsonRequest(base, "/api/handouts", { cookie: two })).payload.handouts.filter((item) => item.domain === "function");
    assert.deepEqual(topics.map((item) => item.title), ["一次函数中的规律问题", "一次函数的折叠问题"], "topics are shared and keep the arranged order");

    // 学生讲义: only the student's own teacher can list, open, save, arrange or delete it; deleting the student removes it.
    const student = await jsonRequest(base, "/api/students", { cookie: one, method: "POST", body: { student: { name: "CICI", className: "初二" } } });
    assert.equal(student.response.status, 201);
    const studentId = student.payload.student.id;
    const ownHandout = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "CICI-期中复习", items: [{ id: "s", kind: "section", title: "勾股定理复习", note: "" }], studentId, domain: "geometry" } } });
    assert.equal(ownHandout.response.status, 201);
    const personal = ownHandout.payload.handout;
    assert.deepEqual([personal.studentId, personal.studentName, personal.grade, personal.term, personal.domain, personal.position], [studentId, "CICI", null, null, null, 0]);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: two, method: "POST", body: { handout: { title: "冒用", items: [], studentId } } })).response.status, 404, "another teacher's student is not a place");
    assert.ok(!(await jsonRequest(base, "/api/handouts", { cookie: two })).payload.handouts.some((item) => item.id === personal.id), "other teachers do not list it");
    assert.equal((await jsonRequest(base, `/api/handouts/${personal.id}`, { cookie: two })).response.status, 404);
    assert.equal((await jsonRequest(base, `/api/handouts/${personal.id}`, { cookie: admin })).response.status, 404, "not even an admin opens another teacher's student handout");
    assert.equal((await jsonRequest(base, `/api/handouts/${personal.id}`, { cookie: two, method: "PUT", body: { handout: { title: "改掉", items: [] } } })).response.status, 404);
    assert.equal((await jsonRequest(base, `/api/handouts/${personal.id}`, { cookie: two, method: "DELETE", body: {} })).response.status, 404);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: two, method: "PATCH", body: { domain: "function", ids: [personal.id] } })).response.status, 200);
    const mine = (await jsonRequest(base, "/api/handouts", { cookie: one })).payload.handouts.find((item) => item.id === personal.id);
    assert.deepEqual([mine.studentId, mine.studentName, mine.title], [studentId, "CICI", "CICI-期中复习"], "another teacher's arrange cannot pull it out of the student");
    const saved2 = await jsonRequest(base, `/api/handouts/${personal.id}`, { cookie: one, method: "PUT", body: { handout: { title: "CICI-期中复习（二）", items: [] } } });
    assert.deepEqual([saved2.response.status, saved2.payload.handout.studentName], [200, "CICI"]);

    // Moving a shared handout to the student makes it private to that teacher.
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: two, method: "PATCH", body: { studentId, ids: [otherTerm.payload.handout.id] } })).response.status, 404);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { studentId, ids: [personal.id, otherTerm.payload.handout.id] } })).response.status, 200);
    assert.ok(!(await jsonRequest(base, "/api/handouts", { cookie: two })).payload.handouts.some((item) => item.id === otherTerm.payload.handout.id), "a handout moved to a student leaves the shared shelves");
    const studentShelf = (await jsonRequest(base, "/api/handouts", { cookie: one })).payload.handouts.filter((item) => item.studentId === studentId);
    assert.deepEqual(studentShelf.map((item) => [item.title, item.grade, item.term, item.position]), [["CICI-期中复习（二）", null, null, 0], ["寒假第一讲", null, null, 1]]);

    const extra = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "CICI 小测", items: [], studentId } } });
    assert.equal(extra.payload.handout.position, 2, "a new student handout goes to the end of that student's list");
    assert.equal((await jsonRequest(base, `/api/handouts/${extra.payload.handout.id}`, { cookie: one, method: "DELETE", body: {} })).response.status, 200, "the student's teacher deletes it without being an admin");
    assert.equal((await jsonRequest(base, `/api/students/${studentId}`, { cookie: one, method: "DELETE", body: {} })).response.status, 200);
    assert.equal((await jsonRequest(base, `/api/handouts/${personal.id}`, { cookie: one })).response.status, 404, "deleting the student deletes the student's handouts");
    assert.equal((await jsonRequest(base, `/api/handouts/${otherTerm.payload.handout.id}`, { cookie: one })).response.status, 404);

    assert.equal((await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: one, method: "DELETE", body: {} })).response.status, 403);
    assert.equal((await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: admin, method: "DELETE", body: {} })).response.status, 200);
    assert.equal((await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: one })).response.status, 404);
  } finally {
    worker.kill("SIGINT");
    await Promise.race([new Promise((done) => worker.once("exit", done)), new Promise((done) => setTimeout(done, 3_000))]);
    if (worker.exitCode == null) worker.kill("SIGKILL");
  }
});
