import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { loadSource } from "./load-source.mjs";

const { orderedBasketQuestions, moveBasketQuestion, basketIds, basketSections, selectBasketQuestions, placeBasketQuestion, removeBasketSection, groupBasketByType, restoreBasketDraft } = await loadSource("lib/paper-basket.ts");

const pool = [
  { id: "a", type: "解答题" }, { id: "b", type: "单选题" }, { id: "c", type: "填空题" }, { id: "d", type: "单选题" },
].map((question) => ({ ...question, categoryId: "one", stem: question.id, answer: question.id, analysis: "", options: [], difficulty: "基础" }));
const structured = () => ({ sections: [{ id: "one", title: "一、基础", questionIds: ["a", "b"] }, { id: "empty", title: "空组", questionIds: [] }, { id: "two", title: "应用", questionIds: ["c"] }], unassignedIds: ["d"] });

test("selection, cross-section insertion and deleting a heading never duplicate or lose questions", () => {
  const original = structured();
  let next = placeBasketQuestion(original, "b", "two", "c");
  assert.deepEqual(next.sections[2].questionIds, ["b", "c"]);
  next = placeBasketQuestion(next, "d", "two", "c");
  next = placeBasketQuestion(next, "c", null);
  assert.deepEqual(basketIds(next), ["a", "b", "d", "c"]);
  next = selectBasketQuestions(next, ["a", "d", "c", "new", "new"]);
  assert.deepEqual(next.unassignedIds, ["c", "new"], "new selections go to unassigned once");
  next = removeBasketSection(next, "two");
  assert.deepEqual(next.unassignedIds, ["c", "new", "d"]);
  assert.equal(new Set(basketIds(next)).size, basketIds(next).length);
  assert.deepEqual(original, structured(), "operations do not mutate earlier state");
  assert.equal(placeBasketQuestion(next, "a", "missing"), next);
  assert.equal(placeBasketQuestion(next, "missing", null), next);
  const cleared = selectBasketQuestions(next, []);
  assert.deepEqual(basketIds(cleared), []);
  assert.equal(cleared.sections.length, 2, "cancel selection keeps editable empty headings");
});

test("one projection numbers nonempty sections and all questions, and the unassigned tail is printable", () => {
  const sections = basketSections(structured(), pool);
  assert.deepEqual(sections.map((section) => [section.heading, section.start]), [["一、基础", 0], ["", 2], ["二、应用", 2], ["三、其他题目", 3]]);
  const flat = basketSections({ sections: [], unassignedIds: ["d", "b"] }, pool);
  assert.deepEqual(flat.map((section) => section.heading), [""]);
  assert.deepEqual(flat[0].questions.map((question) => question.id), ["d", "b"]);
});

test("type classification is stable and manual edits remain possible afterwards", () => {
  let serial = 0;
  const result = groupBasketByType(structured(), pool, () => String(++serial));
  assert.deepEqual(result.sections.map((section) => [section.title, section.questionIds]), [["单选题", ["b", "d"]], ["填空题", ["c"]], ["解答题", ["a"]]]);
  assert.deepEqual(basketIds(placeBasketQuestion(result, "a", result.sections[0].id, "d")), ["b", "a", "d", "c"]);
});

test("draft restore uses live library content, retains selected wrong snapshots and drops invalid references", () => {
  const wrong = { ...pool[0], id: "wrong", stem: "snapshot" };
  const raw = { version: 1, structure: { sections: [{ id: "one", title: "基础", questionIds: ["a", "a", "gone", "wrong"] }], unassignedIds: ["a", "b"] }, title: "保留标题", includeAnswers: false, snapshots: [wrong, { ...pool[0], stem: "stale" }], typeset: null };
  const { draft, missing } = restoreBasketDraft(raw, pool);
  assert.equal(missing, 1);
  assert.deepEqual(basketIds(draft.structure), ["a", "wrong", "b"]);
  assert.deepEqual(draft.snapshots, [wrong]);
  assert.equal(orderedBasketQuestions([...draft.snapshots, ...pool], ["a"])[0].stem, "a");
  assert.equal(draft.title, raw.title); assert.equal(draft.includeAnswers, false);
  assert.throws(() => restoreBasketDraft({ version: 9 }, pool), /保留原记录/);
});

test("basket follows selected order across modules and omits deleted or repeated IDs", () => {
  const questions = [{ id: "a", moduleId: "one" }, { id: "b", moduleId: "two" }, { id: "c", moduleId: "one" }];
  assert.deepEqual(orderedBasketQuestions(questions, ["c", "deleted", "b", "c", "a"]).map(q => q.id), ["c", "b", "a"]);
  assert.deepEqual(orderedBasketQuestions(questions, []), []);
});

test("moving a basket question preserves membership without mutating the original", () => {
  const ids = ["c", "a", "b"];
  assert.deepEqual(moveBasketQuestion(ids, "a", -1), ["a", "c", "b"]);
  assert.deepEqual(moveBasketQuestion(ids, "a", 1), ["c", "b", "a"]);
  assert.deepEqual(ids, ["c", "a", "b"]);
  assert.equal(moveBasketQuestion(ids, "c", -1), ids);
  assert.equal(moveBasketQuestion(ids, "b", 1), ids);
  assert.equal(moveBasketQuestion(ids, "missing", 1), ids);
});

test("basket Word export preserves mixed question types and matches answer numbering", async () => {
  const { buildQuestionsWordBlob } = await loadSource("lib/export-word.ts");
  const questions = [
    { id: "structured", type: "解答题", stem: "FIRSTQUESTION", answer: "FIRSTANSWER" },
    { id: "choice", type: "单选题", stem: "SECONDQUESTION", answer: "SECONDANSWER" },
    { id: "fill", type: "填空题", stem: "THIRDQUESTION", answer: "THIRDANSWER" },
  ].map(q => ({ ...q, categoryId: "one", difficulty: "基础", options: [], analysis: "" }));
  const blob = await buildQuestionsWordBlob(questions, "组卷顺序回归", true, "basket");
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file("word/document.xml").async("string");
  assert.ok(xml.indexOf("FIRSTQUESTION") < xml.indexOf("SECONDQUESTION"));
  assert.ok(xml.indexOf("SECONDQUESTION") < xml.indexOf("THIRDQUESTION"));
  assert.ok(xml.indexOf("FIRSTANSWER") < xml.indexOf("SECONDANSWER"));
  assert.ok(xml.indexOf("SECONDANSWER") < xml.indexOf("THIRDANSWER"));
  assert.match(xml, /1．答案：[\s\S]*?FIRSTANSWER/);
  assert.match(xml, /2．答案：[\s\S]*?SECONDANSWER/);
  assert.match(xml, /3．答案：[\s\S]*?THIRDANSWER/);
  const defaultBlob = await buildQuestionsWordBlob(questions, "题型顺序回归", false);
  const defaultZip = await JSZip.loadAsync(await defaultBlob.arrayBuffer());
  const defaultXml = await defaultZip.file("word/document.xml").async("string");
  assert.ok(defaultXml.indexOf("SECONDQUESTION") < defaultXml.indexOf("THIRDQUESTION"));
  assert.ok(defaultXml.indexOf("THIRDQUESTION") < defaultXml.indexOf("FIRSTQUESTION"));
});
