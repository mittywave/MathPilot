import assert from "node:assert/strict";
import { bootstrapAdmin } from "./helpers/migrated-d1.mjs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loopbackFetch as fetch } from './helpers/loopback-fetch.mjs';

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const CONFIG = join(ROOT, "dist", "server", "wrangler.json");
const INVITE = "handouts-e2e-invite";

test("0035 and 0036 preserve course, topic and student handouts while adding directories", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE students(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('teacher'); INSERT INTO students VALUES ('student');");
    for (const migration of ["0019_handouts.sql", "0020_handout_placement.sql", "0029_handout_shelves.sql"]) db.exec(await readFile(join(ROOT, "migrations", migration), "utf8"));
    const insert = db.prepare("INSERT INTO handouts (id, owner_user_id, title, items_json, created_at, updated_at, grade, term, position, domain, student_id) VALUES (?, 'teacher', ?, ?, 11, 22, ?, ?, ?, ?, ?)");
    const items = JSON.stringify({ items: [{ id: "module", kind: "section", title: "原模块", note: "原内容" }, { id: "quiz", kind: "quiz", questionId: "temp", scope: "public", moduleId: "module" }], temporaryQuestions: [{ id: "temp", contentImages: ["/api/assets/original"] }] });
    for (const grade of [7, 8, 9]) for (const term of ["summer", "autumn", "winter", "spring"]) insert.run(`${grade}-${term}`, "原讲义", items, grade, term, grade, null, null);
    insert.run("topic", "专题", items, null, null, 3, "geometry", null);
    insert.run("student", "学生讲义", items, null, null, 4, null, "student");
    insert.run("unsorted", "未分板块", "[]", null, null, 5, null, null);
    const before = db.prepare("SELECT * FROM handouts ORDER BY id").all();
    db.exec(await readFile(join(ROOT, "migrations", "0035_handout_courses.sql"), "utf8"));
    const after = db.prepare("SELECT * FROM handouts ORDER BY id").all();
    assert.deepEqual(after.map(row => ({ ...row })), before.map(({ grade, term, ...row }) => ({ ...row, course_unit_id: term ? `course-${grade}-${term}` : null })));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM handout_course_nodes").get().n, 16);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => db.exec("DELETE FROM handout_course_nodes WHERE id='course-7-summer'"), /FOREIGN KEY/);
    assert.throws(() => db.exec("DELETE FROM handout_course_nodes WHERE id='course-default'"), /FOREIGN KEY/);
    db.exec("INSERT INTO handout_course_nodes VALUES ('custom-system', NULL, '专题库', 1)");
    const beforeTopics = db.prepare("SELECT * FROM handouts ORDER BY id").all();
    db.exec(await readFile(join(ROOT, "migrations", "0036_handout_topics.sql"), "utf8"));
    assert.deepEqual(db.prepare("SELECT * FROM handouts ORDER BY id").all(), beforeTopics, "topic folders preserve all handout data");
    assert.deepEqual(db.prepare("SELECT id, name FROM handout_course_nodes WHERE parent_id='topic-library' ORDER BY position").all().map((row) => ({ ...row })), [
      { id: "function", name: "函数" }, { id: "geometry", name: "几何" }, { id: "algebra", name: "代数" }, { id: "number", name: "数论" }, { id: "thinking", name: "数学思想" },
    ]);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const beforePrivacy = db.prepare("SELECT * FROM handout_course_nodes ORDER BY id").all();
    db.exec(await readFile(join(ROOT, "migrations", "0044_handout_course_privacy.sql"), "utf8"));
    assert.deepEqual(db.prepare("SELECT * FROM handout_course_nodes ORDER BY id").all().map(({ is_private, ...node }) => {
      assert.equal(is_private, 0, "all existing systems remain public"); return node;
    }), beforePrivacy.map((node) => ({ ...node })));
    db.exec("UPDATE handout_course_nodes SET is_private=1 WHERE id='course-default'");
    assert.throws(() => db.exec("UPDATE handout_course_nodes SET is_private=1 WHERE id='course-grade-7'"), /CHECK/);
    assert.throws(() => db.exec("UPDATE handout_course_nodes SET is_private=1 WHERE id='topic-library'"), /CHECK/);
    assert.throws(() => db.exec("UPDATE handout_course_nodes SET is_private=2 WHERE id='course-default'"), /CHECK/);
    assert.deepEqual(db.prepare("SELECT * FROM handouts ORDER BY id").all(), beforeTopics, "privacy migration leaves all handout content and placement intact");
  } finally { db.close(); }
});

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
      assert.equal(registration.payload.user.role, "member");
      if (email === "admin@handouts.test") bootstrapAdmin(state, registration.payload.user.id);
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
    assert.deepEqual([list.payload.handouts[0].courseUnitId, list.payload.handouts[0].domain, list.payload.handouts[0].studentId], [null, null, null], "a handout created without a place waits in the unsorted topics");
    const term = { courseUnitId: "course-8-autumn" };
    const lessonIds = [];
    for (const title of ["第一讲", "第二讲"]) {
      const lesson = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title, items: [], ...term } } });
      assert.equal(lesson.response.status, 201);
      assert.deepEqual([lesson.payload.handout.courseUnitId, lesson.payload.handout.position], ["course-8-autumn", lessonIds.length]);
      lessonIds.push(lesson.payload.handout.id);
    }
    const otherTerm = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "寒假第一讲", items: [], courseUnitId: "course-8-winter" } } });
    assert.equal(otherTerm.payload.handout.position, 0, "each term numbers its own 课次");
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { courseUnitId: "missing", ids: lessonIds } })).response.status, 400);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { ...term, ids: lessonIds }, origin: "http://evil.test" })).response.status, 403);
    const arranged = await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { ...term, ids: [lessonIds[1], handout.id, lessonIds[0]] } });
    assert.equal(arranged.response.status, 200);
    const autumn = (await jsonRequest(base, "/api/handouts", { cookie: two })).payload.handouts.filter((item) => item.courseUnitId === "course-8-autumn");
    assert.deepEqual(autumn.map((item) => item.title), ["第二讲", "第3讲 一元一次方程", "第一讲"], "every teacher sees the same 课次 order");
    const saved = await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: one, method: "PUT", body: { handout: { title: "第3讲 一元一次方程", items: reordered } } });
    assert.deepEqual([saved.payload.handout.courseUnitId, saved.payload.handout.position], ["course-8-autumn", 1], "saving content keeps the placement");

    // 专题库: topics sit in one of five domains, number within it and can be reordered.
    const topicIds = [];
    for (const title of ["一次函数的折叠问题", "一次函数中的规律问题"]) {
      const topic = await jsonRequest(base, "/api/handouts", { cookie: two, method: "POST", body: { handout: { title, items: [], domain: "function" } } });
      assert.equal(topic.response.status, 201);
      assert.deepEqual([topic.payload.handout.domain, topic.payload.handout.courseUnitId, topic.payload.handout.position], ["function", null, topicIds.length]);
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
    assert.deepEqual([personal.studentId, personal.studentName, personal.courseUnitId, personal.domain, personal.position], [studentId, "CICI", null, null, 0]);
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
    assert.deepEqual(studentShelf.map((item) => [item.title, item.courseUnitId, item.position]), [["CICI-期中复习（二）", null, 0], ["寒假第一讲", null, 1]]);

    const extra = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "CICI 小测", items: [], studentId } } });
    assert.equal(extra.payload.handout.position, 2, "a new student handout goes to the end of that student's list");
    assert.equal((await jsonRequest(base, `/api/handouts/${extra.payload.handout.id}`, { cookie: one, method: "DELETE", body: {} })).response.status, 200, "the student's teacher deletes it without being an admin");
    assert.equal((await jsonRequest(base, `/api/students/${studentId}`, { cookie: one, method: "DELETE", body: {} })).response.status, 200);
    assert.equal((await jsonRequest(base, `/api/handouts/${personal.id}`, { cookie: one })).response.status, 404, "deleting the student deletes the student's handouts");
    assert.equal((await jsonRequest(base, `/api/handouts/${otherTerm.payload.handout.id}`, { cookie: one })).response.status, 404);

    assert.equal((await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: one, method: "DELETE", body: {} })).response.status, 403);
    assert.equal((await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: admin, method: "DELETE", body: {} })).response.status, 200);
    assert.equal((await jsonRequest(base, `/api/handouts/${handout.id}`, { cookie: one })).response.status, 404);

    // Empty systems persist independently; teachers can author, admins alone delete directories.
    const course = async (body, cookie = one) => jsonRequest(base, "/api/handout-courses", { cookie, method: "POST", body });
    assert.equal((await course({ name: "" })).response.status, 400);
    assert.equal((await course({ name: "too long".repeat(20) })).response.status, 400);
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: one, method: "POST", body: { name: "CSRF" }, origin: "http://evil.test" })).response.status, 403);
    const system = (await course({ name: "自编体系" })).payload.id;
    assert.ok((await jsonRequest(base, "/api/handouts", { cookie: two })).payload.courseNodes.some((node) => node.id === system));
    assert.equal((await course({ name: "自编体系" })).response.status, 409);
    assert.equal((await course({ name: "stage", parentId: "missing" })).response.status, 400);
    const stage = (await course({ name: "基础阶段", parentId: system })).payload.id;
    const unit = (await course({ name: "单元 A", parentId: stage })).payload.id;
    const secondUnit = (await course({ name: "单元 B", parentId: stage })).payload.id;
    assert.equal((await course({ name: "fourth level", parentId: unit })).response.status, 400);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "invalid", courseUnitId: stage } } })).response.status, 400);
    const diy = (await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "自编第一讲", courseUnitId: unit, items: [{ id: "diy-section", kind: "section", title: "自编模块", note: "知识点" }] } } })).payload.handout;
    assert.deepEqual(diy.coursePath.map((node) => node.name), ["自编体系", "基础阶段", "单元 A"]);
    assert.equal((await course({ id: unit, name: "单元 B" })).response.status, 409);
    await course({ id: system, name: "独立体系" }, two);
    assert.equal((await jsonRequest(base, `/api/handouts/${diy.id}`, { cookie: two })).payload.handout.coursePath[0].name, "独立体系");
    const reorderedUnits = (await course({ id: secondUnit, direction: -1 })).payload.courseNodes.filter((node) => node.parentId === stage);
    assert.deepEqual(reorderedUnits.map((node) => node.id), [secondUnit, unit]);
    const extraSystems = [];
    for (const name of ["排序体系 A", "排序体系 B"]) extraSystems.push((await course({ name })).payload.id);
    const beforeDrag = (await jsonRequest(base, "/api/handouts", { cookie: one })).payload.courseNodes;
    const roots = beforeDrag.filter((node) => !node.parentId && node.id !== "topic-library").map((node) => node.id);
    const dragged = (await course({ id: system, direction: 2 })).payload.courseNodes;
    assert.deepEqual(dragged.filter((node) => !node.parentId && node.id !== "topic-library").map((node) => node.id), [roots[0], ...extraSystems, system]);
    assert.deepEqual(dragged.filter((node) => node.parentId || node.id === "topic-library"), beforeDrag.filter((node) => node.parentId || node.id === "topic-library"), "system sorting preserves all descendants and the topic shelf");
    const restored = (await course({ id: system, direction: -2 })).payload.courseNodes;
    assert.deepEqual(restored.filter((node) => !node.parentId && node.id !== "topic-library").map((node) => node.id), roots);
    assert.deepEqual((await jsonRequest(base, `/api/handouts/${diy.id}`, { cookie: two })).payload.handout.items, diy.items);
    for (const direction of [0, 1.5, "1", null]) assert.equal((await course({ id: system, direction })).response.status, 400);
    for (const id of extraSystems) assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id } })).response.status, 200);

    // A private system and every descendant are admin-only, including for its original creator.
    const beforePrivacy = (await jsonRequest(base, `/api/handouts/${diy.id}`, { cookie: one })).payload.handout;
    const privacyImage = "data:image/gif;base64,R0lGODlhAQABAIAAAIAAgAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";
    const imageUpload = await jsonRequest(base, "/api/handout-images", { cookie: one, method: "POST", body: { image: privacyImage } });
    assert.equal(imageUpload.response.status, 201);
    const imageUrl = imageUpload.payload.url;
    const mediaQuestion = { id: "privacy-question", categoryId: "", type: "解答题", difficulty: "基础", stem: "私密临时题", options: [], answer: "1", analysis: "", source: "", contentImages: [imageUrl] };
    const mediaLesson = (await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "私密配图验证", courseUnitId: unit, items: [{ id: "privacy-note", kind: "section", title: "私密模块", note: `配图 ${imageUrl}` }], temporaryQuestions: [mediaQuestion] } } })).payload.handout;
    assert.equal((await fetch(base + imageUrl)).status, 200);
    assert.equal((await fetch(base + imageUrl)).headers.get("cache-control"), "private, no-store", "handout images can be made private later");
    for (const body of [{ id: system, isPrivate: true }, { id: system, isPrivate: false }, { name: "伪造私密体系", isPrivate: true }]) {
      assert.equal((await course(body)).response.status, 403, "members cannot change or forge privacy");
    }
    assert.equal((await course({ id: stage, isPrivate: true }, admin)).response.status, 400);
    assert.equal((await course({ id: "function", isPrivate: true }, admin)).response.status, 400);
    assert.equal((await course({ id: system, isPrivate: "true" }, admin)).response.status, 400);
    const hidden = await course({ id: system, isPrivate: true }, admin);
    assert.equal(hidden.response.status, 200);
    assert.equal(hidden.payload.courseNodes.find((node) => node.id === system).isPrivate, true);
    const hiddenIds = [system, stage, unit, secondUnit];
    for (const cookie of [one, two]) {
      const list = await jsonRequest(base, "/api/handouts", { cookie });
      assert.equal(list.response.headers.get("cache-control"), "private, no-store");
      assert.ok(list.payload.courseNodes.every((node) => !hiddenIds.includes(node.id)), "all private descendants are omitted");
      assert.ok(list.payload.handouts.every((item) => item.id !== diy.id && item.id !== mediaLesson.id), "private titles and module outlines never enter search results");
      assert.equal((await jsonRequest(base, `/api/handouts/${diy.id}`, { cookie })).response.status, 404, "an old editor link cannot read private content");
      assert.equal((await jsonRequest(base, `/api/handouts/${diy.id}`, { cookie, method: "PUT", body: { handout: { title: "越权", items: [] } } })).response.status, 404);
      assert.equal((await course({ id: system, name: "越权" }, cookie)).response.status, 404);
      assert.equal((await course({ id: unit, direction: -1 }, cookie)).response.status, 404);
      assert.equal((await course({ parentId: system, name: "越权阶段" }, cookie)).response.status, 400);
      assert.equal((await jsonRequest(base, "/api/handouts", { cookie, method: "POST", body: { handout: { title: "越权讲义", courseUnitId: unit } } })).response.status, 400);
      assert.equal((await jsonRequest(base, "/api/handouts", { cookie, method: "PATCH", body: { courseUnitId: unit, ids: [mediaLesson.id] } })).response.status, 400, "private targets cannot receive moves");
      assert.equal((await jsonRequest(base, "/api/handouts", { cookie, method: "PATCH", body: { domain: "function", ids: [diy.id, mediaLesson.id] } })).response.status, 200);
      assert.equal((await fetch(base + imageUrl, { headers: { Cookie: cookie } })).status, 404, "known asset URLs cannot bypass privacy");
    }
    assert.equal((await fetch(base + imageUrl)).status, 404, "guests cannot fetch private handout images");
    const adminRead = (await jsonRequest(base, `/api/handouts/${diy.id}`, { cookie: admin })).payload.handout;
    assert.deepEqual(adminRead, { ...beforePrivacy, coursePath: beforePrivacy.coursePath.map((node) => node.id === system ? { ...node, isPrivate: true } : node) }, "blocked writes and moves preserve private handout content and order");
    assert.equal((await fetch(base + imageUrl, { headers: { Cookie: admin } })).status, 200);
    assert.equal((await course({ id: unit, name: "单元 A" }, admin)).response.status, 200, "administrators can maintain private descendants");

    // A reused image remains public when it is independently present in a public handout.
    const publicMedia = (await jsonRequest(base, "/api/handouts", { cookie: admin, method: "POST", body: { handout: { title: "公开复用配图", domain: "function", items: mediaLesson.items } } })).payload.handout;
    assert.equal((await fetch(base + imageUrl, { headers: { Cookie: two } })).status, 200);
    await jsonRequest(base, `/api/handouts/${publicMedia.id}`, { cookie: admin, method: "DELETE" });
    assert.equal((await fetch(base + imageUrl, { headers: { Cookie: two } })).status, 404, "removing the independent public reference restores private-only access");
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: two, method: "POST", body: { handout: { title: "伪造公开配图引用", domain: "function", items: mediaLesson.items } } })).response.status, 403, "copying a known private URL into a public note cannot expose its bytes");
    const mediaModule = (await jsonRequest(base, "/api/modules", { cookie: admin, method: "POST", body: { module: { name: "配图权限验证", subtitle: "" } } })).payload.module;
    const publicQuestion = { ...mediaQuestion, id: "public-privacy-image-question", moduleId: mediaModule.id, categoryId: mediaModule.id };
    assert.equal((await jsonRequest(base, "/api/questions", { cookie: two, method: "POST", body: { question: publicQuestion } })).response.status, 403, "copying a known private URL cannot publish its bytes");
    assert.equal((await jsonRequest(base, "/api/questions", { cookie: admin, method: "POST", body: { question: publicQuestion } })).response.status, 201);
    assert.equal((await fetch(base + imageUrl, { headers: { Cookie: two } })).status, 200, "an administrator can independently publish a reused image in the question library");
    await jsonRequest(base, `/api/questions/${publicQuestion.id}`, { cookie: admin, method: "DELETE" });
    assert.equal((await fetch(base + imageUrl, { headers: { Cookie: two } })).status, 404, "a deleted question no longer makes private images public");
    const publishedAgain = await course({ id: system, isPrivate: false }, admin);
    assert.equal(publishedAgain.payload.courseNodes.find((node) => node.id === system).isPrivate, false);
    assert.deepEqual((await jsonRequest(base, `/api/handouts/${diy.id}`, { cookie: one })).payload.handout, beforePrivacy, "publishing again restores access without changing content");
    assert.equal((await fetch(base + imageUrl, { headers: { Cookie: two } })).status, 200);
    await jsonRequest(base, `/api/handouts/${mediaLesson.id}`, { cookie: admin, method: "DELETE" });

    // The default system's alternate knowledge graph view obeys the same privacy.
    assert.equal((await course({ id: "course-default", isPrivate: true }, admin)).response.status, 200);
    assert.equal((await jsonRequest(base, "/api/knowledge-graph?graph=sz-innovation-course", { cookie: two })).response.status, 404);
    assert.equal((await jsonRequest(base, "/api/knowledge-graph?graph=sz-innovation-course", { cookie: admin })).response.status, 200);
    assert.equal((await jsonRequest(base, "/api/knowledge-graph", { cookie: two })).response.status, 200, "the independent general graph stays available");
    await course({ id: "course-default", isPrivate: false }, admin);
    assert.equal((await jsonRequest(base, "/api/knowledge-graph?graph=sz-innovation-course", { cookie: two })).response.status, 200);

    for (const id of [system, stage, unit]) assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: one, method: "DELETE", body: { id } })).response.status, 403, "members cannot delete directories or their lessons");
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: one, method: "DELETE", body: { id: secondUnit } })).response.status, 403);
    await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { courseUnitId: secondUnit, ids: [diy.id] } });
    const movedDiy = (await jsonRequest(base, `/api/handouts/${diy.id}`, { cookie: two })).payload.handout;
    assert.equal(movedDiy.courseUnitId, secondUnit);
    assert.deepEqual(movedDiy.items, diy.items);
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id: unit } })).response.status, 200);

    // Topics reuse the directory workflow, while handouts retain their domain ID.
    const topic = (await course({ name: "计算能力", parentId: "topic-library" })).payload.id;
    const emptyTopic = (await course({ name: "空专题", parentId: "topic-library" }, two)).payload.id;
    const listedTopics = (await jsonRequest(base, "/api/handouts", { cookie: two })).payload;
    assert.ok(listedTopics.courseNodes.some((node) => node.id === topic && node.parentId === "topic-library"));
    assert.ok(!listedTopics.handouts.some((item) => item.domain === topic), "an empty topic persists without a placeholder handout");
    assert.equal((await course({ name: "计算能力", parentId: "topic-library" })).response.status, 409);
    assert.equal((await course({ id: "topic-library", name: "入口" })).response.status, 400);
    assert.equal((await course({ id: "topic-library", direction: 1 })).response.status, 400);
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id: "topic-library" } })).response.status, 400);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "invalid", domain: system } } })).response.status, 400);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "invalid", courseUnitId: topic } } })).response.status, 400);
    const topicHandout = (await jsonRequest(base, "/api/handouts", { cookie: two, method: "POST", body: { handout: { title: "分式计算", domain: topic, items: diy.items } } })).payload.handout;
    assert.deepEqual([topicHandout.domain, topicHandout.domainName, topicHandout.courseUnitId], [topic, "计算能力", null]);
    await course({ id: topic, name: "运算能力" }, two);
    const renamedTopicHandout = (await jsonRequest(base, `/api/handouts/${topicHandout.id}`, { cookie: one })).payload.handout;
    assert.equal(renamedTopicHandout.domainName, "运算能力");
    assert.deepEqual(renamedTopicHandout.items, topicHandout.items);
    assert.equal((await course({ id: topic, name: "空专题" })).response.status, 409);
    const reorderedTopics = (await course({ id: emptyTopic, direction: -1 })).payload.courseNodes.filter((node) => node.parentId === "topic-library");
    assert.deepEqual(reorderedTopics.slice(-2).map((node) => node.id), [emptyTopic, topic]);
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: one, method: "DELETE", body: { id: topic } })).response.status, 403, "members cannot delete a topic containing handouts");
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: one, method: "DELETE", body: { id: emptyTopic } })).response.status, 403);
    await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { domain: emptyTopic, ids: [topicHandout.id] } });
    const movedTopicHandout = (await jsonRequest(base, `/api/handouts/${topicHandout.id}`, { cookie: two })).payload.handout;
    assert.deepEqual([movedTopicHandout.domain, movedTopicHandout.domainName, movedTopicHandout.position], [emptyTopic, "空专题", 0]);
    assert.deepEqual(movedTopicHandout.items, topicHandout.items);
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id: topic } })).response.status, 200);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { domain: topic, ids: [topicHandout.id] } })).response.status, 400, "deleted topics cannot receive handouts");
    await course({ id: "geometry", name: "平面几何" });
    const originalTopicHandout = (await jsonRequest(base, `/api/handouts/${geometry.payload.handout.id}`, { cookie: two })).payload.handout;
    assert.deepEqual([originalTopicHandout.domain, originalTopicHandout.domainName], ["geometry", "平面几何"], "renaming an original topic preserves its existing handouts");

    // Compatibility: old series are now outline directories; their direct handouts remain readable.
    const inverse = (await course({ name: "反比例", parentId: "function" })).payload.id;
    const quadratic = (await course({ name: "二次", parentId: "function" }, two)).payload.id;
    const movingPoint = (await course({ name: "动点问题", parentId: "function" })).payload.id;
    const seriesList = (await jsonRequest(base, "/api/handouts", { cookie: two })).payload;
    assert.deepEqual(seriesList.courseNodes.filter((node) => node.parentId === "function").map((node) => node.id), [inverse, quadratic, movingPoint]);
    assert.ok(!seriesList.handouts.some((item) => [inverse, quadratic, movingPoint].includes(item.domain)), "empty series persist independently of lessons");
    assert.equal((await course({ name: "反比例", parentId: "function" })).response.status, 409);
    assert.equal((await course({ name: "反比例", parentId: "geometry" })).response.status, 200, "different categories can use the same series name");
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "invalid course", courseUnitId: inverse } } })).response.status, 400, "a topic series is never a course unit");
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { courseUnitId: inverse, ids: [diy.id] } })).response.status, 400);
    const inverseLessons = [];
    for (const title of ["反比例函数的概念", "反比例函数的图象"]) {
      const lesson = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title, domain: inverse, items: diy.items } } });
      assert.equal(lesson.response.status, 201);
      assert.deepEqual([lesson.payload.handout.domain, lesson.payload.handout.domainName, lesson.payload.handout.courseUnitId, lesson.payload.handout.position], [inverse, "反比例", null, inverseLessons.length]);
      assert.deepEqual(lesson.payload.handout.coursePath.map((node) => node.name), ["专题库", "函数", "反比例"]);
      inverseLessons.push(lesson.payload.handout);
    }
    const quadraticLesson = (await jsonRequest(base, "/api/handouts", { cookie: two, method: "POST", body: { handout: { title: "二次函数", domain: quadratic, items: [] } } })).payload.handout;
    assert.equal(quadraticLesson.position, 0, "series number their own lessons independently");
    await course({ id: inverse, name: "反比例提高" }, two);
    await course({ id: "function", name: "函数专题" });
    const savedSeriesLesson = (await jsonRequest(base, `/api/handouts/${inverseLessons[0].id}`, { cookie: one, method: "PUT", body: { handout: { title: "反比例函数入门", items: diy.items } } })).payload.handout;
    assert.deepEqual([savedSeriesLesson.domain, savedSeriesLesson.domainName], [inverse, "反比例提高"]);
    assert.deepEqual(savedSeriesLesson.coursePath.map((node) => node.name), ["专题库", "函数专题", "反比例提高"]);
    const sharedSeriesLesson = (await jsonRequest(base, "/api/handouts", { cookie: two })).payload.handouts.find((item) => item.id === savedSeriesLesson.id);
    assert.deepEqual(sharedSeriesLesson.coursePath, savedSeriesLesson.coursePath, "list and editor share the current category and series breadcrumb");
    assert.deepEqual(sharedSeriesLesson.outline, [{ title: "自编模块", questionIds: [] }]);
    const reorderedSeries = (await course({ id: quadratic, direction: -1 })).payload.courseNodes.filter((node) => node.parentId === "function");
    assert.deepEqual(reorderedSeries.map((node) => node.id), [quadratic, inverse, movingPoint]);
    for (const id of ["function", inverse]) assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: one, method: "DELETE", body: { id } })).response.status, 403);
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: one, method: "DELETE", body: { id: movingPoint } })).response.status, 403);
    await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { domain: quadratic, ids: [quadraticLesson.id, ...inverseLessons.map((item) => item.id)] } });
    const movedSeriesLesson = (await jsonRequest(base, `/api/handouts/${savedSeriesLesson.id}`, { cookie: two })).payload.handout;
    assert.deepEqual([movedSeriesLesson.domain, movedSeriesLesson.position, movedSeriesLesson.title], [quadratic, 1, "反比例函数入门"]);
    assert.deepEqual(movedSeriesLesson.items, savedSeriesLesson.items);
    assert.deepEqual(movedSeriesLesson.coursePath.map((node) => node.name), ["专题库", "函数专题", "二次"]);
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id: inverse } })).response.status, 200);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { domain: inverse, ids: [savedSeriesLesson.id] } })).response.status, 400);
    await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { domain: movingPoint, ids: [originalTopicHandout.id] } });
    const classifiedLegacy = (await jsonRequest(base, `/api/handouts/${originalTopicHandout.id}`, { cookie: two })).payload.handout;
    assert.equal(classifiedLegacy.domain, movingPoint, "old direct category handouts can move into a series without changing content");
    assert.deepEqual(classifiedLegacy.items, originalTopicHandout.items);

    // 专题库 → 函数 → 二次函数（左侧大纲）→ 性质 / 图像（右侧分组）→ 讲义。
    const properties = (await course({ name: "二次函数的性质", parentId: quadratic })).payload.id;
    const graph = (await course({ name: "二次函数的图像", parentId: quadratic }, two)).payload.id;
    const groupedList = (await jsonRequest(base, "/api/handouts", { cookie: two })).payload;
    assert.deepEqual(groupedList.courseNodes.filter((node) => node.parentId === quadratic).map((node) => node.id), [properties, graph]);
    assert.ok(!groupedList.handouts.some((item) => [properties, graph].includes(item.domain)), "empty topic groups persist before lectures are written");
    assert.equal((await course({ name: "二次函数的性质", parentId: quadratic })).response.status, 409);
    assert.equal((await course({ name: "二次函数的性质", parentId: movingPoint })).response.status, 200, "the same topic name can be used in another outline");
    assert.equal((await course({ name: "too deep", parentId: properties })).response.status, 400);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "invalid", courseUnitId: properties } } })).response.status, 400);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "invalid", domain: "topic-library" } } })).response.status, 400);
    const groupedLesson = (await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "开口与对称轴", domain: properties, items: diy.items } } })).payload.handout;
    assert.deepEqual([groupedLesson.domain, groupedLesson.domainName, groupedLesson.courseUnitId, groupedLesson.position], [properties, "二次函数的性质", null, 0]);
    assert.deepEqual(groupedLesson.coursePath.map((node) => node.id), ["topic-library", "function", quadratic, properties]);
    await course({ id: quadratic, name: "二次函数" });
    await course({ id: "function", name: "函数" });
    await course({ id: properties, name: "二次函数的性质与应用" }, two);
    const savedGroupedLesson = (await jsonRequest(base, `/api/handouts/${groupedLesson.id}`, { cookie: one, method: "PUT", body: { handout: { title: groupedLesson.title, items: groupedLesson.items } } })).payload.handout;
    assert.deepEqual(savedGroupedLesson.coursePath.map((node) => node.name), ["专题库", "函数", "二次函数", "二次函数的性质与应用"]);
    assert.equal(savedGroupedLesson.domain, properties);
    const sharedGroupedLesson = (await jsonRequest(base, "/api/handouts", { cookie: two })).payload.handouts.find((item) => item.id === groupedLesson.id);
    assert.deepEqual(sharedGroupedLesson.coursePath, savedGroupedLesson.coursePath);
    const reorderedGroups = (await course({ id: graph, direction: -1 })).payload.courseNodes.filter((node) => node.parentId === quadratic);
    assert.deepEqual(reorderedGroups.map((node) => node.id), [graph, properties]);
    for (const id of ["function", quadratic, properties]) assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: one, method: "DELETE", body: { id } })).response.status, 403, "members cannot delete nonempty groups or their ancestors");
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { courseUnitId: graph, ids: [groupedLesson.id] } })).response.status, 400);
    await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { domain: graph, ids: [quadraticLesson.id, groupedLesson.id] } });
    const movedGroupedLesson = (await jsonRequest(base, `/api/handouts/${groupedLesson.id}`, { cookie: two })).payload.handout;
    assert.deepEqual([movedGroupedLesson.domain, movedGroupedLesson.position, movedGroupedLesson.title], [graph, 1, groupedLesson.title]);
    assert.deepEqual(movedGroupedLesson.coursePath.map((node) => node.name), ["专题库", "函数", "二次函数", "二次函数的图像"]);
    assert.deepEqual(movedGroupedLesson.items, groupedLesson.items);
    const movedOldOutlineLesson = (await jsonRequest(base, `/api/handouts/${quadraticLesson.id}`, { cookie: two })).payload.handout;
    assert.equal(movedOldOutlineLesson.position, 0, "legacy outline handouts can be filed in topic groups");
    assert.deepEqual(movedOldOutlineLesson.items, quadraticLesson.items);
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: one, method: "DELETE", body: { id: properties } })).response.status, 403);
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id: properties } })).response.status, 200);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { domain: properties, ids: [groupedLesson.id] } })).response.status, 400);

    const tempQuestion = { id: "temp-equation", categoryId: "", type: "解答题", difficulty: "中等", stem: "解方程 $x+2=5$。", options: [], answer: "3", analysis: "移项得 $x=3$。", source: "", importFileName: "外部试卷.docx", contentImages: [pixel],
      stemDocxXml: ['<w:p><m:oMath><m:r><m:t>x+2=5</m:t></m:r></m:oMath></w:p>'], createdAt: Date.now(), updatedAt: Date.now() };
    const temporary = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "临时题库验证", courseUnitId: "course-7-summer", temporaryQuestions: [tempQuestion], items: [
      { id: "ts", kind: "section", title: "方程", note: "" }, { id: "tq", kind: "question", questionId: tempQuestion.id, scope: "public", band: "example" },
      { id: "tquiz", kind: "quiz", questionId: tempQuestion.id, scope: "public", moduleId: "ts" },
    ] } } });
    assert.equal(temporary.response.status, 201);
    const temp = temporary.payload.handout;
    assert.equal(temp.temporaryQuestions.length, 1);
    assert.match(temp.temporaryQuestions[0].contentImages[0], /^\/api\/assets\//);
    assert.deepEqual(temp.temporaryQuestions[0].stemDocxXml, tempQuestion.stemDocxXml);
    assert.ok(!(await jsonRequest(base, "/api/library", { cookie: one })).payload.questions.some((q) => q.id === tempQuestion.id), "temporary questions never leak into the formal library");
    const roundtrip = (await jsonRequest(base, `/api/handouts/${temp.id}`, { cookie: two })).payload.handout;
    assert.deepEqual(roundtrip.temporaryQuestions, temp.temporaryQuestions);
    assert.equal((await jsonRequest(base, "/api/handouts", { cookie: two })).payload.handouts.find((h) => h.id === temp.id).temporaryQuestions, undefined);
    const legacyUpdate = await jsonRequest(base, `/api/handouts/${temp.id}`, { cookie: one, method: "PUT", body: { handout: { title: temp.title, items: temp.items } } });
    assert.deepEqual(legacyUpdate.payload.handout.temporaryQuestions, temp.temporaryQuestions, "updates by older clients retain the temporary library");
    const copy = (await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "副本", items: temp.items, temporaryQuestions: temp.temporaryQuestions } } })).payload.handout;
    assert.equal(copy.temporaryQuestions[0].id, tempQuestion.id);
    for (const temporaryQuestions of [[{ ...tempQuestion, stem: "" }], [tempQuestion, tempQuestion], {}, Array.from({ length: 401 }, (_, i) => ({ ...tempQuestion, id: `many-${i}` }))]) {
      assert.equal((await jsonRequest(base, `/api/handouts/${temp.id}`, { cookie: one, method: "PUT", body: { handout: { title: temp.title, items: temp.items, temporaryQuestions } } })).response.status, 400);
    }
    assert.equal((await jsonRequest(base, `/api/handouts/${temp.id}`, { cookie: one })).payload.handout.temporaryQuestions.length, 1, "invalid saves leave the prior library intact");
    await jsonRequest(base, `/api/handouts/${copy.id}`, { cookie: admin, method: "DELETE", body: {} });
    assert.equal((await jsonRequest(base, `/api/handouts/${temp.id}`, { cookie: one })).payload.handout.temporaryQuestions.length, 1, "removing a copy never removes source questions");
    const privateStudent = (await jsonRequest(base, "/api/students", { cookie: one, method: "POST", body: { student: { name: "临时题权限验证" } } })).payload.student;
    const privateImage = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>').toString('base64')}`;
    const privateHandout = (await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "私有临时题", studentId: privateStudent.id, items: [], temporaryQuestions: [{ ...tempQuestion, contentImages: [privateImage] }] } } })).payload.handout;
    const privateUrl = privateHandout.temporaryQuestions[0].contentImages[0];
    assert.equal((await fetch(base + privateUrl, { headers: { Cookie: one } })).status, 200);
    assert.equal((await fetch(base + privateUrl, { headers: { Cookie: two } })).status, 404, "student temporary figures remain private");
    await jsonRequest(base, "/api/handouts", { cookie: two, method: "PATCH", body: { domain: "function", ids: [privateHandout.id] } });
    assert.equal((await fetch(base + privateUrl, { headers: { Cookie: two } })).status, 404, "an unauthorized move cannot grant figure access");
    await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { domain: "function", ids: [privateHandout.id] } });
    assert.equal((await fetch(base + privateUrl, { headers: { Cookie: two } })).status, 200, "an authorized move to the shared shelf shares its figures too");

    // Deleting any course/topic level removes the whole subtree, without touching other shelves or formal questions.
    const formalBefore = (await jsonRequest(base, "/api/library", { cookie: one })).payload.questions;
    for (const topicShelf of [false, true]) {
      const root = (await course({ name: topicShelf ? "专题删除验证" : "体系删除验证", parentId: topicShelf ? "topic-library" : null })).payload.id;
      const middle = (await course({ name: "下级目录", parentId: root })).payload.id;
      const leaf = (await course({ name: "内容分组", parentId: middle })).payload.id;
      const empty = (await course({ name: "空分组", parentId: middle })).payload.id;
      const ids = [root, middle, leaf, empty];
      const lessons = [];
      for (const domain of topicShelf ? [root, middle, leaf] : [leaf]) {
        const created = await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: {
          title: "随目录删除", ...(topicShelf ? { domain } : { courseUnitId: leaf }), items: temp.items, temporaryQuestions: temp.temporaryQuestions,
        } } });
        assert.equal(created.response.status, 201);
        lessons.push(created.payload.handout.id);
      }
      const before = (await jsonRequest(base, "/api/handouts", { cookie: one })).payload;
      if (!topicShelf) {
        // Fail after lectures and children have been removed: D1 must roll back the entire batch.
        const trigger = `CREATE TRIGGER reject_directory_delete BEFORE DELETE ON handout_course_nodes WHEN OLD.id = '${root}' BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END`;
        const inject = spawnSync(WRANGLER, ["d1", "execute", "DB", "--local", "--persist-to", state, "--config", "wrangler.jsonc", "--command", trigger], { cwd: ROOT, encoding: "utf8" });
        assert.equal(inject.status, 0, inject.stdout + inject.stderr);
        assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id: root } })).response.status, 500);
        assert.deepEqual((await jsonRequest(base, "/api/handouts", { cookie: one })).payload, before, "failed deletion leaves every directory and lecture intact");
        const remove = spawnSync(WRANGLER, ["d1", "execute", "DB", "--local", "--persist-to", state, "--config", "wrangler.jsonc", "--command", "DROP TRIGGER reject_directory_delete"], { cwd: ROOT, encoding: "utf8" });
        assert.equal(remove.status, 0, remove.stdout + remove.stderr);
      }
      const deleted = await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id: root } });
      assert.equal(deleted.response.status, 200);
      assert.deepEqual(deleted.payload.courseNodes, before.courseNodes.filter((node) => !ids.includes(node.id)));
      const after = (await jsonRequest(base, "/api/handouts", { cookie: one })).payload;
      assert.deepEqual(after.handouts, before.handouts.filter((item) => !lessons.includes(item.id)), "unrelated and student handouts stay unchanged");
      for (const id of lessons) assert.equal((await jsonRequest(base, `/api/handouts/${id}`, { cookie: one })).response.status, 404);
      assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id: root } })).response.status, 404);
      assert.equal((await course({ name: "已删除位置", parentId: middle })).response.status, 400);
    }
    assert.deepEqual((await jsonRequest(base, "/api/library", { cookie: one })).payload.questions, formalBefore, "formal questions survive directory deletion");

    // Sparse lesson numbers reuse position for both course units and topic groups.
    for (const topicShelf of [false, true]) {
      const root = (await course({ name: "任意讲次", parentId: topicShelf ? "topic-library" : null })).payload.id;
      const middle = (await course({ name: "讲次大纲", parentId: root })).payload.id;
      const leaf = (await course({ name: "讲次分组", parentId: middle })).payload.id;
      const group = topicShelf ? { domain: leaf } : { courseUnitId: leaf };
      const create = (position, cookie = one) => jsonRequest(base, "/api/handouts", { cookie, method: "POST", body: { handout: { ...group, title: "任意讲次内容", items: diy.items, position } } });
      const eight = await create(7);
      const three = await create(2, two);
      const nine = await create(undefined);
      for (const created of [eight, three, nine]) assert.equal(created.response.status, 201);
      assert.deepEqual([eight, three, nine].map((item) => item.payload.handout.position), [7, 2, 8], "create lesson 8 first, backfill 3, then append 9");
      for (const position of [-1, 1.5, "8", null, Number.MAX_SAFE_INTEGER]) assert.equal((await create(position)).response.status, 400);
      const duplicate = await create(7, two);
      assert.equal(duplicate.response.status, 409);
      assert.match(duplicate.payload.error, /第8讲已存在/);
      const concurrent = await Promise.all([create(11), create(11, two)]);
      assert.deepEqual(concurrent.map((item) => item.response.status).sort(), [201, 409], "a concurrent duplicate never creates a second lesson 12");
      const ids = [nine, eight, three].map((item) => item.payload.handout.id);
      assert.equal((await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { ...group, ids } })).response.status, 200);
      const reordered = await Promise.all(ids.map((id) => jsonRequest(base, `/api/handouts/${id}`, { cookie: two })));
      assert.deepEqual(reordered.map((item) => item.payload.handout.position), [2, 7, 8], "reorder preserves the occupied lesson slots, including gaps");
      assert.deepEqual(reordered[0].payload.handout.items, diy.items);
      const incoming = (await jsonRequest(base, "/api/handouts", { cookie: one, method: "POST", body: { handout: { title: "移入讲义", items: [] } } })).payload.handout;
      await jsonRequest(base, "/api/handouts", { cookie: one, method: "PATCH", body: { ...group, ids: [incoming.id] } });
      assert.equal((await jsonRequest(base, `/api/handouts/${incoming.id}`, { cookie: two })).payload.handout.position, 12, "a partial move appends after lesson 12 without overwriting existing slots");
      assert.equal((await jsonRequest(base, `/api/handouts/${ids[0]}`, { cookie: admin, method: "DELETE", body: {} })).response.status, 200);
      assert.equal((await jsonRequest(base, `/api/handouts/${ids[1]}`, { cookie: two })).payload.handout.position, 7, "deleting an earlier lesson leaves later numbers unchanged");
      const filled = await create(2);
      assert.equal(filled.response.status, 201, "a deleted lesson number can be filled again");
      const listed = (await jsonRequest(base, "/api/handouts", { cookie: two })).payload.handouts.filter((item) => topicShelf ? item.domain === leaf : item.courseUnitId === leaf);
      assert.deepEqual(listed.map((item) => item.position), [2, 7, 8, 11, 12]);
    }
  } finally {
    worker.kill("SIGINT");
    await Promise.race([new Promise((done) => worker.once("exit", done)), new Promise((done) => setTimeout(done, 3_000))]);
    if (worker.exitCode == null) worker.kill("SIGKILL");
  }
});
