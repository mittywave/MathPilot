import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadSource } from "./load-source.mjs";

// 快速排版的历史记录除了 Word，也存智能组卷按天挑好的题库题目清单。
const MIGRATIONS = new URL("../migrations/", import.meta.url);

async function migrate(sqlite, until = "9999") {
  for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith(".sql")).sort()) {
    if (name >= until) break;
    sqlite.exec(await readFile(new URL(name, MIGRATIONS), "utf8"));
  }
}

// Actual SQLite SQL and constraints behind the D1 method shape the server module uses.
function d1(sqlite) {
  return {
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...args) }; },
        async run() { const result = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: result.changes } }; },
        execute() { const prepared = sqlite.prepare(sql); return prepared.columns().length ? prepared.all(...args) : prepared.run(...args); },
      };
      return statement;
    },
    async batch(statements) { sqlite.exec("BEGIN"); try { const results = statements.map((statement) => statement.execute()); sqlite.exec("COMMIT"); return results; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } },
  };
}

const seed = `
  INSERT INTO users (id, email, password_hash, password_salt, password_iterations, role, created_at) VALUES ('u1', 'one@test', 'h', 's', 1, 'member', 0), ('u2', 'two@test', 'h', 's', 1, 'member', 0);
  INSERT INTO question_assets (id, content_type, byte_size, created_at) VALUES ('a1', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1, 0);
`;

test("0031 keeps every Word record and lets a record hold a question list instead", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  await migrate(sqlite, "0031");
  sqlite.exec(seed);
  sqlite.exec(`INSERT INTO typeset_records (id, owner_user_id, title, file_name, question_count, source_asset_id, settings_json, created_at, updated_at)
    VALUES ('r1', 'u1', '周练', '周练.docx', 20, 'a1', '{"answers":"end"}', 1, 2)`);
  sqlite.exec(await readFile(new URL("0031_typeset_library_records.sql", MIGRATIONS), "utf8"));

  assert.deepEqual({ ...sqlite.prepare("SELECT * FROM typeset_records WHERE id = 'r1'").get() }, {
    id: "r1", owner_user_id: "u1", title: "周练", file_name: "周练.docx", question_count: 20, source_kind: "word", source_asset_id: "a1",
    plan_json: "{}", student_id: null, settings_json: '{"answers":"end"}', created_at: 1, updated_at: 2,
  });
  assert.throws(() => sqlite.exec("INSERT INTO typeset_records (id, owner_user_id, title, file_name, source_kind, source_asset_id, created_at, updated_at) VALUES ('x', 'u1', 't', '', 'library', 'a1', 0, 0)"), /CHECK/, "a question list holds no Word");
  assert.throws(() => sqlite.exec("INSERT INTO typeset_records (id, owner_user_id, title, file_name, created_at, updated_at) VALUES ('y', 'u1', 't', 't.docx', 0, 0)"), /CHECK/, "a Word record keeps its Word");
  const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'typeset_records'").all().map((row) => row.name);
  assert.ok(indexes.includes("idx_typeset_records_owner_updated") && indexes.includes("idx_typeset_records_owner_student"));
});

test("智能组卷 records: own students only, questions once each, used questions per student, no Word to read", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  await migrate(sqlite);
  sqlite.exec(seed);
  sqlite.exec(`INSERT INTO students (id, owner_user_id, name, class_name, notes, created_at, updated_at) VALUES ('s1', 'u1', '刘羽汐', '初二', '', 0, 0), ('s2', 'u2', '别人的学生', '', '', 0, 0);
    INSERT INTO typeset_records (id, owner_user_id, title, file_name, question_count, source_kind, source_asset_id, settings_json, created_at, updated_at) VALUES ('w1', 'u1', '周练', '周练.docx', 20, 'word', 'a1', '{}', 1, 1);`);
  const records = await loadSource("lib/server/typeset-records.ts", { DB: d1(sqlite) });
  const teacher = { id: "u1", email: "one@test", role: "member" };
  const plan = {
    request: "给刘羽汐出 2 天计算打卡", studentId: "s1",
    brief: { title: "计算打卡", days: 2, perDay: 2, categoryIds: ["calc-rational-mixed"], questionTypes: ["解答题"], difficulty: "由易到难", focus: [{ label: "去括号", description: "括号前是负号" }] },
    findings: [{ label: "计算", evidence: "计算类错误 37 次" }], avoided: 3,
    groups: [
      { title: "第 1 天", theme: "热身", items: [{ id: "q1", focus: "去括号", reason: "括号前负号" }, { id: "q2", focus: "通分", reason: "分母不同" }] },
      { title: "第 2 天", theme: "提高", items: [{ id: "q2", focus: "重复", reason: "重复的题只留一次" }, { id: "q3", focus: "分配律", reason: "" }] },
    ],
  };

  const created = await records.createTypesetRecord(teacher, { title: "刘羽汐 · 计算打卡", plan, settings: { answers: "end", showSource: true } });
  assert.equal(created.sourceKind, "library");
  assert.equal(created.studentName, "刘羽汐");
  assert.equal(created.questionCount, 3, "a question appears once in a plan");
  assert.deepEqual(created.plan.groups.map((group) => group.items.map((item) => item.id)), [["q1", "q2"], ["q3"]]);
  assert.deepEqual(created.settings, { answers: "end", showSource: true });

  await assert.rejects(records.createTypesetRecord(teacher, { plan: { ...plan, studentId: "s2" } }), (error) => error instanceof Response && error.status === 404, "another teacher's student");
  await assert.rejects(records.createTypesetRecord(teacher, { plan: { ...plan, groups: [{ title: "第 1 天", items: [] }] } }), (error) => error instanceof Response && error.status === 400, "a plan without questions");

  const updated = await records.updateTypesetRecord(teacher, created.id, { settings: { answers: "end", showSource: false }, plan: { ...plan, groups: [{ title: "第 1 天", theme: "", items: [{ id: "q4", focus: "", reason: "" }] }] } });
  assert.equal(updated.questionCount, 1);
  assert.equal((await records.listTypesetRecords(teacher)).find((record) => record.id === created.id).settings.showSource, false, "the source setting survives saving and reopening a history record");
  await assert.rejects(records.updateTypesetRecord(teacher, "w1", { plan }), (error) => error instanceof Response && error.status === 400, "a Word record has no question list");

  const second = await records.createTypesetRecord(teacher, { plan });
  assert.equal(second.title, "计算打卡", "the brief's title is the default");
  assert.deepEqual([...await records.usedQuestionIds(teacher, "s1")].sort(), ["q1", "q2", "q3", "q4"]);

  const listed = await records.listTypesetRecords(teacher);
  assert.equal(listed.find((record) => record.id === "w1").plan, null);
  assert.equal(listed.find((record) => record.id === "w1").sourceKind, "word");
  await assert.rejects(records.readTypesetSource(teacher, second.id), (error) => error instanceof Response && error.status === 404);

  await records.deleteTypesetRecord(teacher, second.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM question_assets WHERE id = 'a1'").get().n, 1, "deleting a question list leaves Word files alone");
  sqlite.exec("DELETE FROM students WHERE id = 's1'");
  assert.equal(sqlite.prepare("SELECT student_id FROM typeset_records WHERE id = ?").get(created.id).student_id, null, "the record outlives the student");
});

test("history recipients come from active homework, deduplicate uploads and assignments, and follow current student names/classes", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON;");
    await migrate(sqlite);
    sqlite.exec(seed);
    sqlite.exec(`INSERT INTO students (id, owner_user_id, name, class_name, created_at, updated_at) VALUES
      ('s1', 'u1', '甲', '一班', 0, 0), ('s2', 'u1', '乙', '一班', 0, 0), ('s3', 'u1', '独立学生', '', 0, 0),
      ('s4', 'u1', '已取消学生', '二班', 0, 0), ('foreign', 'u2', '其他老师的学生', '一班', 0, 0);
      INSERT INTO typeset_records (id, owner_user_id, title, file_name, source_asset_id, created_at, updated_at)
        VALUES ('w1', 'u1', '计算练习', '计算练习.docx', 'a1', 1, 2);`);
    const records = await loadSource("lib/server/typeset-records.ts", { DB: d1(sqlite) });
    const teacher = { id: "u1" }, other = { id: "u2" };
    const plan = await records.createTypesetRecord(teacher, { plan: { studentId: "s1", groups: [{ items: [{ id: "q1" }] }] } });
    assert.deepEqual(plan.assignedTo, [], "preparing a plan for a student is not assigning it");
    const insertAssignment = sqlite.prepare("INSERT INTO homework_assignments (id,owner_user_id,title,status,sheet_json,created_at,updated_at) VALUES (?,?,'计算练习',?,?,0,0)");
    const insertSubmission = sqlite.prepare("INSERT INTO homework_submissions (id,assignment_id,student_id,version,status,submitted_by_type,submitted_by_id,created_at,updated_at) VALUES (?,?,?,?,'draft','teacher',?,0,0)");
    const assign = (id, student, sheet = { recordId: "w1" }, owner = "u1", status = "published") => {
      insertAssignment.run(id, owner, status, typeof sheet === "string" ? sheet : JSON.stringify(sheet));
      insertSubmission.run(`${id}-1`, id, student, 1, owner);
    };
    assign("a1", "s1"); assign("a2", "s2"); assign("a3", "s3"); assign("cancelled", "s4", { recordId: "w1" }, "u1", "archived");
    assign("repeat", "s1"); insertSubmission.run("a1-2", "a1", "s1", 2, "u1");
    assign("foreign-owner", "foreign", { recordId: "w1" }, "u2"); assign("foreign-student", "foreign");
    assign("legacy", "s4", { groups: [] }); assign("malformed", "s4", "invalid json"); assign("uploaded", "s4", "");
    assign("plan", "s2", { recordId: plan.id });
    // Half-written homework without a submission is not an actual handout.
    insertAssignment.run("unfinished", "u1", "published", JSON.stringify({ recordId: "w1" }));

    let listed = await records.listTypesetRecords(teacher);
    const word = listed.find((record) => record.id === "w1");
    assert.deepEqual(word.assignedTo, [{ id: "s3", name: "独立学生", className: "" }, { id: "s2", name: "乙", className: "一班" }, { id: "s1", name: "甲", className: "一班" }]);
    assert.deepEqual(listed.find((record) => record.id === plan.id).assignedTo.map((student) => student.id), ["s2"]);
    assert.deepEqual(await records.listTypesetRecords(other), [], "recipients never grant access to another teacher's record");
    const { TypesetHistory } = await loadSource("app/tools/typeset/TypesetHistory.tsx");
    const html = renderToStaticMarkup(createElement(TypesetHistory, { records: [word], current: null, now: 0, busy: false, onOpen() {}, onDelete() {} }));
    assert.match(html, /已布置给：独立学生、一班（乙、甲）/);
    assert.doesNotMatch(html, /已取消学生|其他老师的学生/);

    sqlite.exec("UPDATE students SET name = '改名甲', class_name = '新班' WHERE id = 's1'; UPDATE homework_assignments SET status = 'archived' WHERE id = 'a1';");
    const updated = await records.updateTypesetRecord(teacher, "w1", { settings: { answers: "end" } });
    assert.ok(updated.assignedTo.some((student) => student.name === "改名甲" && student.className === "新班"), "one cancelled copy does not erase a still-active assignment, including after autosave");
    sqlite.exec("UPDATE homework_assignments SET status = 'archived' WHERE id = 'repeat'; DELETE FROM students WHERE id = 's2';");
    listed = await records.listTypesetRecords(teacher);
    assert.deepEqual(listed.find((record) => record.id === "w1").assignedTo.map((student) => student.id), ["s3"]);
    assert.deepEqual(listed.find((record) => record.id === plan.id).assignedTo, []);
  } finally { sqlite.close(); }
});
