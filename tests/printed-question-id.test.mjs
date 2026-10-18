import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";
import { docxPrintedQuestionId } from "../lib/docx-import-rules.mjs";
import { d1, migratedDatabase } from "./helpers/migrated-d1.mjs";
import { loadSource } from "./load-source.mjs";

// 打印出去的卷子在题号旁印着题目 ID；学生做完拍照上传时按 ID 认题，不靠题干比对。
const { createQuestionMatcher } = await loadSource("lib/question-identity.ts");
const { normalizeCompletedQuestions, printedQuestionId } = await loadSource("lib/completed-homework-contract.ts");
const { mergePageExtractions, normalizePageExtraction } = await loadSource("lib/completed-homework-coverage.ts");
const { buildWordBlob } = await loadSource("lib/export-word.ts");

const COMMON = "如图，在平面直角坐标系中，点A的坐标为(2,4)，过点(3,0)作x轴的垂线l，点A与点B关于直线l对称．";
const PART_1 = "(1)求点B的坐标；", PART_2 = "(2)点C的坐标为(6,0)，求四边形OABC的面积．";
const LIBRARY_STEM = COMMON + PART_1 + PART_2;

test("a printed ID is read as its digits, and nothing else read there counts as one", () => {
  for (const [read, id] of [["ID 1322", "1322"], ["1322", "1322"], ["ID1322", "1322"], ["ＩＤ ０１２３", "123"], ["#1340", "1340"], ["3", ""], ["5-3", ""], ["ID 13", ""], ["第1322题", ""], ["", ""], [null, ""]]) assert.equal(printedQuestionId(read), id, String(read));
  const raw = (printed) => ({ question_number: "5-3", page_numbers: [1], type: "解答题", stem: "求值", options: [], student_answer: "", answer_state: "readable", question_complete: true, bbox: null, knowledge_tags: [], capability_keys: [], printed_id: printed });
  assert.equal(normalizeCompletedQuestions({ questions: [raw("ID 0063")] }, 1)[0].printed_id, "63");
  assert.equal("printed_id" in normalizeCompletedQuestions({ questions: [raw("")] }, 1)[0], false, "no ID, no field: readings without one stay as they were");
  // A question running on to the next page keeps the ID its first page showed.
  const page = (number, printed) => normalizePageExtraction({ questions: [{ ...raw(printed), question_number: "3-1", page_numbers: [3, 4] }], page: { page_number: number, kind: "questions", question_numbers: ["3-1"], reason: "" } }, number, [3, 4], 4);
  assert.equal(mergePageExtractions([page(3, "ID 1322"), page(4, "")])[0].printed_id, "1322");
  assert.equal(mergePageExtractions([page(3, ""), page(4, "ID 1322")])[0].printed_id, "1322");
});

test("a printed ID is taken only when the question on the paper is the one it names", () => {
  const matcher = createQuestionMatcher();
  matcher.add("lib", { stem: LIBRARY_STEM });
  matcher.add("calc", { stem: "计算：$(-\\frac{3}{4}-\\frac{5}{9}+\\frac{7}{12})\\div\\frac{1}{36}$" });
  assert.equal(matcher.confirms("lib", { stem: `5. ${LIBRARY_STEM.replace("如图，", "")}` }), true, "the same question, read a little differently");
  assert.equal(matcher.confirms("lib", { stem: COMMON + PART_2 }, true), true, "a sub-question read on its own is part of its question");
  assert.equal(matcher.confirms("lib", { stem: COMMON + PART_2 }), false, "but a whole question must be all of it");
  assert.equal(matcher.confirms("lib", { stem: LIBRARY_STEM.replace("(2,4)", "(2,5)") }), false, "one number differs: a misread ID names another question");
  assert.equal(matcher.confirms("calc", { stem: "计算：$(-\\frac{3}{4}-\\frac{5}{9}+\\frac{7}{12})\\div\\frac{1}{72}$" }), false, "a 计算 variant one number away");
  assert.equal(matcher.confirms("calc", { stem: "计算：$(-\\frac{3}{4}-\\frac{5}{9}+\\frac{7}{12})\\div\\frac{17}{2}$" }), false, "1/72 and 17/2 are different numbers");
  assert.equal(matcher.confirms("unknown", { stem: LIBRARY_STEM }), false, "an ID that is not this teacher's question");
});

test("Word question lists print each question's ID after its number, a handout's bands do not, and reading it back takes the ID out", async () => {
  const base = { categoryId: "c", difficulty: "基础", tags: [], analysis: "", answer: "", options: [] };
  const plain = { ...base, id: "p", code: "1322", type: "解答题", stem: "已知点 $A(2,4)$，求 $OA$" };
  const printed = { ...base, id: "w", code: "0063", type: "解答题", stem: "7．求值", stemDocxXml: ['<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>7．求值</w:t></w:r></w:p>'] };
  const headed = { ...base, id: "h", code: "1340", type: "解答题", stem: "已知 2.5", stemDocxXml: ['<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">已知 2.5</w:t></w:r></w:p>'] };
  const uncoded = { ...base, id: "u", type: "解答题", stem: "没有编号的题" };
  const band = { ...base, id: "b", code: "2001", type: "解答题", stem: "例题不印编号" };
  const blob = await buildWordBlob({ title: "编号", answers: "none", sections: [{ questions: [plain, printed, headed, uncoded] },
    { questions: [band], part: { key: "example", label: "例题", tagline: "", prefix: "例" } }] });
  const xml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml").async("string");
  assert.equal(XMLValidator.validate(xml), true);
  const paragraphs = Array.from(xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g), ([paragraph]) => ({ xml: paragraph, text: Array.from(paragraph.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g), (match) => match[1]).join("") }));
  const starting = (text) => paragraphs.find((paragraph) => paragraph.text.startsWith(text));
  assert.ok(starting("1．ID 1322 已知点"), "a plain stem");
  assert.ok(starting("2．ID 0063 求值"), "a stem kept as its Word paragraph, which printed its own number");
  assert.ok(starting("3．ID 1340 已知 2.5"), "a stem kept as its Word paragraph without a number");
  assert.match(starting("2．ID 0063").xml, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">2．<\/w:t>/, "the number keeps its run's format");
  assert.match(starting("1．ID 1322").xml, /<w:bdr [^>]*w:val="single"/, "the ID is boxed");
  assert.ok(starting("4．没有编号的题"));
  assert.ok(paragraphs.some((paragraph) => paragraph.text.includes("例题不印编号")) && !xml.includes("ID 2001"));
  // Read back, each ID is the question's and the stem is as it was.
  for (const [start, id, stem] of [["1．ID 1322", "1322", "1．已知点"], ["2．ID 0063", "63", "2．求值"], ["3．ID 1340", "1340", "3．已知 2.5"]]) {
    const paragraph = starting(start), read = docxPrintedQuestionId(paragraph.text, paragraph.xml);
    assert.equal(read.id, id);
    assert.ok(read.text.startsWith(stem), read.text);
    assert.doesNotMatch(read.xml, /ID \d/);
    assert.equal(XMLValidator.validate(`<w:document xmlns:w="w" xmlns:m="m">${read.xml}</w:document>`), true);
  }
  // A Word read back without taking its ID out keeps that one instead of getting a second.
  const kept = { ...printed, id: "k", stemDocxXml: [starting("2．ID 0063").xml] };
  const again = await (await JSZip.loadAsync(await (await buildWordBlob({ title: "再导出", answers: "none", sections: [{ questions: [kept] }] })).arrayBuffer())).file("word/document.xml").async("string");
  assert.equal((again.match(/ID 0063/g) ?? []).length, 1);
});

const user = { id: "u", email: "u@test", role: "admin" };

async function setup() {
  const sqlite = await migratedDatabase();
  sqlite.exec(`INSERT INTO users (id, email, password_hash, password_salt, password_iterations, role, created_at) VALUES ('u', 'u@test', 'h', 's', 1, 'admin', 0);
    INSERT INTO students (id, owner_user_id, name, class_name, notes, created_at, updated_at) VALUES ('s1', 'u', '小宇', '', '', 1, 1);
    INSERT INTO library_questions_v2 (row_id, source_id, library_id, publication_id, module_source_id, payload_json, content_hash, created_at, updated_at)
      VALUES ('r1', 'lib-q', 'public', 'legacy', 'm', '${JSON.stringify({ id: "lib-q", categoryId: "m", type: "解答题", difficulty: "中等", stem: LIBRARY_STEM, options: [], answer: "B(4,4)", analysis: "", source: "题库", tags: [] })}', 'x', 1, 1);`);
  const code = String(sqlite.prepare("SELECT number FROM question_codes WHERE question_id = 'lib-q'").get().number);
  return { sqlite, code };
}

// One uploaded homework, read from one photographed page: each question as the model read it, with the ID it saw.
function upload(sqlite, id, created, questions) {
  sqlite.exec(`INSERT INTO homework_assignments (id, owner_user_id, title, status, created_at, updated_at) VALUES ('${id}', 'u', '作业${id}', 'published', ${created}, ${created});
    INSERT INTO homework_submissions (id, assignment_id, student_id, version, status, submitted_by_type, submitted_by_id, created_at, updated_at) VALUES ('sub-${id}', '${id}', 's1', 1, 'published', 'teacher', 'u', ${created}, ${created});
    INSERT INTO homework_assets (id, owner_user_id, r2_key, content_type, byte_size, content_hash, created_at) VALUES ('o-${id}', 'u', 'k-${id}', 'image/jpeg', 1, 'photo-${id}', ${created}), ('p-${id}', 'u', 'kp-${id}', 'image/jpeg', 1, 'p-${id}', ${created});
    INSERT INTO submission_pages (id, submission_id, original_asset_id, processed_asset_id, page_order, created_at) VALUES ('page-${id}', 'sub-${id}', 'o-${id}', 'p-${id}', 0, ${created});`);
  const gradingItems = questions.map((question, index) => {
    const aq = `${id}-q${index}`;
    sqlite.prepare(`INSERT INTO assignment_questions (id, assignment_id, question_number, page_number, type, stem, options_json, answer, created_at, updated_at, sort_order, input_evidence_json)
      VALUES (?, ?, ?, 1, '解答题', ?, '[]', '', ?, ?, ?, ?)`).run(aq, id, question.number, question.stem, created, created, index, JSON.stringify(question.printed ? { printed_id: question.printed } : {}));
    sqlite.prepare("INSERT INTO grading_items (id, submission_id, assignment_question_id, verdict, requires_review, page_id, created_at, updated_at) VALUES (?, ?, ?, 'incorrect', 0, ?, ?, ?)").run(`g-${aq}`, `sub-${id}`, aq, `page-${id}`, created, created);
    return { id: `g-${aq}`, assignmentQuestionId: aq, questionNumber: question.number, verdict: "incorrect", requiresReview: false, referenceVerified: true, studentAnswer: "答", feedback: "错", pageId: `page-${id}`, bbox: null, createdAt: created };
  });
  return { id: `sub-${id}`, assignmentId: id, studentId: "s1", assignmentTitle: `作业${id}`, gradingItems, pages: [] };
}

test("an uploaded question whose paper printed its ID is filed under that question, as the library has it", async () => {
  const { sqlite, code } = await setup();
  const { syncSubmissionWrongBook } = await loadSource("lib/server/homework-wrong-book.ts", { DB: d1(sqlite) });
  const book = await loadSource("lib/server/student-wrong-book.ts", { DB: d1(sqlite) });
  const keyOf = (aq) => sqlite.prepare("SELECT question_key FROM assignment_questions WHERE id = ?").get(aq).question_key;
  // Read from the photo with a phrase left out: too different for the content match, but the ID names it.
  await syncSubmissionWrongBook(upload(sqlite, "a1", 10, [{ number: "1-5", printed: code, stem: `5. ${LIBRARY_STEM.replace("如图，在平面直角坐标系中，", "")}` }]), user);
  assert.equal(keyOf("a1-q0"), "lib-q");
  let [entry, ...rest] = await book.readWrongQuestions("s1", user);
  assert.equal(rest.length, 0);
  assert.equal(entry.question.stem, LIBRARY_STEM, "the wrong book shows the library's question, not the photo's reading");
  assert.equal(entry.question.code, code.padStart(4, "0"));
  // Read again as its two sub-questions, both wrong on one photo: one more mistake on the same question.
  await syncSubmissionWrongBook(upload(sqlite, "a2", 20, [{ number: "1-2(1)", printed: code, stem: COMMON + PART_1 }, { number: "1-2(2)", printed: code, stem: COMMON + PART_2 }]), user);
  assert.deepEqual([keyOf("a2-q0"), keyOf("a2-q1")], ["lib-q", "lib-q"]);
  [entry, ...rest] = await book.readWrongQuestions("s1", user);
  assert.equal(rest.length, 0);
  assert.equal(entry.mistakeCount, 2);
  assert.equal(entry.question.stem, LIBRARY_STEM);
  // A misread ID (the question has another number) or an ID that names nothing is not taken.
  await syncSubmissionWrongBook(upload(sqlite, "a3", 30, [{ number: "1-1", printed: code, stem: LIBRARY_STEM.replace("(6,0)", "(8,0)") }, { number: "1-2", printed: "9999", stem: "已知 $x+1=3$，求 $x$ 的值，并写出检验过程。" }]), user);
  assert.equal(keyOf("a3-q0"), "a3-q0");
  assert.equal(keyOf("a3-q1"), "a3-q1");
  assert.equal((await book.readWrongQuestions("s1", user)).length, 3);
});
