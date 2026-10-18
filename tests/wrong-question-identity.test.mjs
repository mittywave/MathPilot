import assert from "node:assert/strict";
import test from "node:test";
import { d1, migratedDatabase } from "./helpers/migrated-d1.mjs";
import { loadSource } from "./load-source.mjs";

// 同一道题在作业、错题本和题库里只用一个 ID：再做错同一道题，错题本里仍是一条，错的次数加一。
const user = { id: "u", email: "u@test", role: "admin" };
const STEM_A = "如图，在▱ABCD中，对角线AC，BD相交于点O，过点O作MN⊥BD，分别交AD，BC于点M，N．求证：四边形BNDM是菱形．";
// The same question read again from another photo: printed number, half-width punctuation and LaTeX.
const STEM_A_AGAIN = "3. 如图,在$\\square ABCD$中,对角线$AC$,$BD$相交于点$O$,过点$O$作$MN \\perp BD$,分别交$AD$,$BC$于点$M$,$N$.求证:四边形$BNDM$是菱形.";

async function setup() {
  const sqlite = await migratedDatabase();
  sqlite.exec(`INSERT INTO users (id, email, password_hash, password_salt, password_iterations, role, created_at) VALUES ('u', 'u@test', 'h', 's', 1, 'admin', 0);
    INSERT INTO students (id, owner_user_id, name, class_name, notes, created_at, updated_at) VALUES ('s1', 'u', '小宇', '', '', 1, 1), ('s2', 'u', '小林', '', '', 1, 1);`);
  return sqlite;
}

// One homework handed in and graded: each question either got wrong (verdict incorrect) or right.
function homework(sqlite, id, created, questions) {
  sqlite.exec(`INSERT INTO homework_assignments (id, owner_user_id, title, status, created_at, updated_at) VALUES ('${id}', 'u', '作业${id}', 'published', ${created}, ${created})`);
  for (const [index, question] of questions.entries()) {
    sqlite.prepare(`INSERT INTO assignment_questions (id, assignment_id, question_number, page_number, type, stem, options_json, answer, created_at, updated_at, sort_order, source_json)
      VALUES (?, ?, ?, 1, '解答题', ?, ?, '', ?, ?, ?, ?)`).run(question.id, id, String(index + 1), question.stem, JSON.stringify(question.options ?? []), created, created, index, question.source ? JSON.stringify(question.source) : "");
  }
}

function submission(sqlite, assignmentId, studentId, created, items) {
  const id = `sub-${assignmentId}-${studentId}`;
  sqlite.exec(`INSERT INTO homework_submissions (id, assignment_id, student_id, version, status, submitted_by_type, submitted_by_id, created_at, updated_at) VALUES ('${id}', '${assignmentId}', '${studentId}', 1, 'published', 'teacher', 'u', ${created}, ${created})`);
  const gradingItems = items.map(([questionId, verdict], index) => {
    const item = { id: `g-${id}-${index}`, assignmentQuestionId: questionId, questionNumber: String(index + 1), verdict, requiresReview: false, referenceVerified: true, studentAnswer: "答", feedback: "错", pageId: null, bbox: null, createdAt: created };
    sqlite.prepare("INSERT INTO grading_items (id, submission_id, assignment_question_id, verdict, requires_review, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(item.id, id, questionId, verdict, created, created);
    return item;
  });
  return { id, assignmentId, studentId, assignmentTitle: `作业${assignmentId}`, gradingItems, pages: [] };
}

test("the same question got wrong twice stays one wrong-book entry with one ID", async () => {
  const sqlite = await setup();
  const { syncSubmissionWrongBook } = await loadSource("lib/server/homework-wrong-book.ts", { DB: d1(sqlite) });
  const book = await loadSource("lib/server/student-wrong-book.ts", { DB: d1(sqlite) });
  homework(sqlite, "a1", 10, [{ id: "q1", stem: STEM_A }, { id: "q2", stem: "计算：$(-3)^{-2}$的平方根是多少？请写出完整过程。" }]);
  await syncSubmissionWrongBook(submission(sqlite, "a1", "s1", 10, [["q1", "incorrect"], ["q2", "correct"]]), user);
  // Exported from the wrong book, printed, done again and photographed: no link back, only the same content.
  homework(sqlite, "a2", 20, [{ id: "q3", stem: STEM_A_AGAIN }]);
  await syncSubmissionWrongBook(submission(sqlite, "a2", "s1", 20, [["q3", "incorrect"]]), user);

  const entries = await book.readWrongQuestions("s1", user);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].mistakeCount, 2);
  assert.equal(entries[0].sourceQuestionId, "q1", "the first time it was got wrong names it");
  assert.equal(entries[0].question.id, "q1");
  assert.match(entries[0].question.code, /^\d{4,}$/);
  assert.equal(entries[0].question.stem, STEM_A, "the entry keeps the question as it first entered the book");
  assert.equal(sqlite.prepare("SELECT question_key FROM assignment_questions WHERE id = 'q3'").get().question_key, "q1");
  assert.equal(sqlite.prepare("SELECT question_key FROM assignment_questions WHERE id = 'q2'").get().question_key, "", "a question never got wrong gets no ID");

  // Another student gets it wrong: their own entry, the same ID; the library page lists it once.
  homework(sqlite, "a3", 30, [{ id: "q4", stem: STEM_A }]);
  await syncSubmissionWrongBook(submission(sqlite, "a3", "s2", 30, [["q4", "incorrect"]]), user);
  assert.equal((await book.readWrongQuestions("s2", user))[0].question.code, entries[0].question.code);
  const catalog = await book.readWrongQuestionCatalog(user);
  assert.equal(catalog.length, 1);
  assert.deepEqual(catalog[0].students.map((student) => student.name).sort(), ["小宇", "小林"].sort());
  assert.equal(catalog[0].mistakeCount, 3);
});

test("a wrong-book question handed out again keeps its ID through the assignment", async () => {
  const sqlite = await setup();
  const { syncSubmissionWrongBook } = await loadSource("lib/server/homework-wrong-book.ts", { DB: d1(sqlite) });
  const book = await loadSource("lib/server/student-wrong-book.ts", { DB: d1(sqlite) });
  homework(sqlite, "a1", 10, [{ id: "q1", stem: STEM_A }]);
  await syncSubmissionWrongBook(submission(sqlite, "a1", "s1", 10, [["q1", "incorrect"]]), user);
  // 布置作业 copies the wrong-book snapshot, whose id is the question's ID, even after the teacher edits the wording.
  homework(sqlite, "a2", 20, [{ id: "q9", stem: "改写过的题干，内容已经完全不同了，但它仍然是错题本里那一道题。", source: { id: "q1", stem: "改写过的题干" } }]);
  await syncSubmissionWrongBook(submission(sqlite, "a2", "s1", 20, [["q9", "incorrect"]]), user);
  const entries = await book.readWrongQuestions("s1", user);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].mistakeCount, 2);
});

test("different numbers or options are different questions", async () => {
  const { createQuestionMatcher } = await loadSource("lib/question-identity.ts");
  const matcher = createQuestionMatcher();
  matcher.add("light", { stem: "在平面直角坐标系中，已知B(-2,0)关于y轴对称的点为B'，从点A(2,4)发出一条光线，经过y轴反射后经过点B，求光线所在直线。" });
  matcher.add("say", { stem: "下列说法正确的是（　　）", options: ["A. 对顶角相等", "B. 同位角相等", "C. 内错角相等", "D. 同旁内角互补"] });
  assert.equal(matcher.find({ stem: "在平面直角坐标系中,已知B(-2,0)关于y轴对称的点为B',从点A(2,4)发出一束光线,经过y轴反射后经过点B,求光线所在直线." }), "light");
  assert.equal(matcher.find({ stem: "在平面直角坐标系中，已知B(-3,0)关于y轴对称的点为B'，从点A(2,4)发出一条光线，经过y轴反射后经过点B，求光线所在直线。" }), null);
  assert.equal(matcher.find({ stem: "下列说法正确的是( )", options: ["对顶角相等", "同位角相等", "内错角相等", "同旁内角互补"] }), "say");
  assert.equal(matcher.find({ stem: "下列说法正确的是（　　）", options: ["A. 对顶角相等", "B. 同位角相等", "C. 内错角相等", "D. 两点之间线段最短"] }), null);
  assert.equal(matcher.find({ stem: "下列说法不正确的是（　　）", options: ["A. 对顶角相等", "B. 同位角相等", "C. 内错角相等", "D. 同旁内角互补"] }), null);
  // Too short to tell apart without its figure.
  matcher.add("short", { stem: "如图，求∠1的度数。" });
  assert.equal(matcher.find({ stem: "如图，求∠1的度数。" }), null);
});

test("wrong books written before IDs fold their copies of one question on first read", async () => {
  const sqlite = await setup();
  const book = await loadSource("lib/server/student-wrong-book.ts", { DB: d1(sqlite) });
  homework(sqlite, "a1", 10, [{ id: "q1", stem: STEM_A }]);
  homework(sqlite, "a2", 20, [{ id: "q3", stem: STEM_A_AGAIN }]);
  sqlite.exec(`INSERT INTO homework_submissions (id, assignment_id, student_id, version, status, submitted_by_type, submitted_by_id, created_at, updated_at) VALUES ('x1', 'a1', 's1', 1, 'published', 'teacher', 'u', 10, 10), ('x2', 'a2', 's1', 1, 'published', 'teacher', 'u', 20, 20);
    INSERT INTO grading_items (id, submission_id, assignment_question_id, verdict, requires_review, created_at, updated_at) VALUES ('g1', 'x1', 'q1', 'incorrect', 0, 10, 10), ('g2', 'x2', 'q3', 'incorrect', 0, 20, 20);
    INSERT INTO student_wrong_occurrences (grading_item_id, owner_user_id, student_id, assignment_id, assignment_question_id, submission_id, active, created_at, updated_at) VALUES ('g1', 'u', 's1', 'a1', 'q1', 'x1', 1, 10, 10), ('g2', 'u', 's1', 'a2', 'q3', 'x2', 1, 20, 20);
    INSERT INTO libraries_v2 (id, kind, owner_user_id, created_at) VALUES ('personal:u', 'personal', 'u', 1);
    INSERT INTO student_wrong_questions (id, owner_user_id, student_id, source_scope, source_library_id, source_question_id, question_snapshot_json, mistake_count, last_wrong_at, created_at, updated_at, source_kind, assignment_id)
      VALUES ('w1', 'u', 's1', 'mine', 'personal:u', 'q1', '${JSON.stringify({ id: "q1", stem: STEM_A, options: [] })}', 1, 10, 10, 10, 'assignment', 'a1'),
             ('w2', 'u', 's1', 'mine', 'personal:u', 'q3', '${JSON.stringify({ id: "q3", stem: STEM_A_AGAIN, options: [] })}', 1, 20, 20, 20, 'assignment', 'a2');`);
  assert.equal((await book.readStudents(user)).find((student) => student.id === "s1").wrongCount, 1);
  const entries = await book.readWrongQuestions("s1", user);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "w2", "the newest copy stays");
  assert.equal(entries[0].sourceQuestionId, "q1");
  assert.equal(entries[0].mistakeCount, 2);
  assert.match(entries[0].question.code, /^\d{4,}$/);
  assert.deepEqual(sqlite.prepare("SELECT question_key FROM student_wrong_occurrences ORDER BY grading_item_id").all().map((row) => row.question_key), ["q1", "q1"]);
  // A basket saved before still holds the copy under its old homework-question ID; it still exports.
  const { authorizeQuestionDownload } = await loadSource("lib/server/library.ts", { DB: d1(sqlite) });
  assert.equal(await authorizeQuestionDownload(user, ["q1", "q3"]), true);
  assert.equal(await authorizeQuestionDownload(user, ["q3", "unknown"]), false);
});

test("the same page photo handed in again is not another mistake", async () => {
  const sqlite = await setup();
  const { syncSubmissionWrongBook } = await loadSource("lib/server/homework-wrong-book.ts", { DB: d1(sqlite) });
  const book = await loadSource("lib/server/student-wrong-book.ts", { DB: d1(sqlite) });
  // Each upload is its own homework with its own page; the first two pages are the same picture.
  for (const [index, hash] of ["same", "same", "new"].entries()) {
    const id = `a${index}`, created = 10 * (index + 1);
    homework(sqlite, id, created, [{ id: `q${index}`, stem: STEM_A }]);
    const graded = submission(sqlite, id, "s1", created, [[`q${index}`, "incorrect"]]);
    sqlite.exec(`INSERT INTO homework_assets (id, owner_user_id, r2_key, content_type, byte_size, content_hash, created_at) VALUES ('o${index}', 'u', 'k${index}', 'image/jpeg', 1, '${hash}', ${created}), ('p${index}', 'u', 'kp${index}', 'image/jpeg', 1, 'p${index}', ${created});
      INSERT INTO submission_pages (id, submission_id, original_asset_id, processed_asset_id, page_order, created_at) VALUES ('page${index}', '${graded.id}', 'o${index}', 'p${index}', 0, ${created});
      UPDATE grading_items SET page_id = 'page${index}' WHERE submission_id = '${graded.id}';`);
    await syncSubmissionWrongBook({ ...graded, gradingItems: graded.gradingItems.map((item) => ({ ...item, pageId: `page${index}` })) }, user);
    const [entry] = await book.readWrongQuestions("s1", user);
    assert.equal(entry.mistakeCount, [1, 1, 2][index]);
  }
});

test("a duplicate the teacher deleted before IDs is folded in without counting again, even after re-grading", async () => {
  const sqlite = await setup();
  const { syncSubmissionWrongBook } = await loadSource("lib/server/homework-wrong-book.ts", { DB: d1(sqlite) });
  const book = await loadSource("lib/server/student-wrong-book.ts", { DB: d1(sqlite) });
  homework(sqlite, "a1", 10, [{ id: "q1", stem: STEM_A }]);
  homework(sqlite, "a2", 20, [{ id: "q3", stem: STEM_A_AGAIN }]);
  sqlite.exec(`INSERT INTO homework_submissions (id, assignment_id, student_id, version, status, submitted_by_type, submitted_by_id, created_at, updated_at) VALUES ('sub-a1-s1', 'a1', 's1', 1, 'published', 'teacher', 'u', 10, 10), ('x2', 'a2', 's1', 1, 'published', 'teacher', 'u', 20, 20);
    INSERT INTO grading_items (id, submission_id, assignment_question_id, verdict, requires_review, created_at, updated_at) VALUES ('g1', 'sub-a1-s1', 'q1', 'incorrect', 0, 10, 10), ('g2', 'x2', 'q3', 'incorrect', 0, 20, 20);
    INSERT INTO student_wrong_occurrences (grading_item_id, owner_user_id, student_id, assignment_id, assignment_question_id, submission_id, active, created_at, updated_at) VALUES ('g1', 'u', 's1', 'a1', 'q1', 'sub-a1-s1', 1, 10, 10), ('g2', 'u', 's1', 'a2', 'q3', 'x2', 1, 20, 20);
    INSERT INTO libraries_v2 (id, kind, owner_user_id, created_at) VALUES ('personal:u', 'personal', 'u', 1);
    INSERT INTO student_wrong_questions (id, owner_user_id, student_id, source_scope, source_library_id, source_question_id, question_snapshot_json, mistake_count, last_wrong_at, created_at, updated_at, source_kind, assignment_id, archived_at, archive_reason)
      VALUES ('w1', 'u', 's1', 'mine', 'personal:u', 'q1', '${JSON.stringify({ id: "q1", stem: STEM_A, options: [] })}', 1, 10, 10, 30, 'assignment', 'a1', 30, '老师删除'),
             ('w2', 'u', 's1', 'mine', 'personal:u', 'q3', '${JSON.stringify({ id: "q3", stem: STEM_A_AGAIN, options: [] })}', 1, 20, 20, 20, 'assignment', 'a2', NULL, '');`);
  let [entry, ...rest] = await book.readWrongQuestions("s1", user, true);
  assert.equal(rest.length, 0, "the deleted copy is folded into the kept one");
  assert.deepEqual([entry.id, entry.archivedAt, entry.mistakeCount], ["w2", null, 1]);
  // Re-grading the old homework re-writes its occurrence; the teacher's dismissal stays.
  await syncSubmissionWrongBook({ id: "sub-a1-s1", assignmentId: "a1", studentId: "s1", assignmentTitle: "作业a1", pages: [],
    gradingItems: [{ id: "g1", assignmentQuestionId: "q1", questionNumber: "1", verdict: "incorrect", requiresReview: false, referenceVerified: true, studentAnswer: "答", feedback: "错", pageId: null, bbox: null, createdAt: 10 }] }, user);
  [entry, ...rest] = await book.readWrongQuestions("s1", user, true);
  assert.equal(rest.length, 0);
  assert.equal(entry.mistakeCount, 1);
  // A new mistake after that still counts.
  homework(sqlite, "a3", 50, [{ id: "q5", stem: STEM_A }]);
  await syncSubmissionWrongBook(submission(sqlite, "a3", "s1", 50, [["q5", "incorrect"]]), user);
  [entry] = await book.readWrongQuestions("s1", user);
  assert.equal(entry.mistakeCount, 2);
});
