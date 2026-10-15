import assert from "node:assert/strict";
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

    // Empty systems persist independently; teachers can author, admins alone delete empty nodes.
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
    for (const id of [system, stage, unit]) assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id } })).response.status, 409, "nonempty outline nodes cannot delete lessons");
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
    assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id: topic } })).response.status, 409, "a topic containing handouts cannot be deleted");
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
    for (const id of ["function", inverse]) assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id } })).response.status, 409);
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
    for (const id of ["function", quadratic, properties]) assert.equal((await jsonRequest(base, "/api/handout-courses", { cookie: admin, method: "DELETE", body: { id } })).response.status, 409, "nonempty groups and every ancestor protect lectures");
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
  } finally {
    worker.kill("SIGINT");
    await Promise.race([new Promise((done) => worker.once("exit", done)), new Promise((done) => setTimeout(done, 3_000))]);
    if (worker.exitCode == null) worker.kill("SIGKILL");
  }
});
