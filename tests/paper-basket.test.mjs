import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { loadSource } from "./load-source.mjs";

const { orderedBasketQuestions, moveBasketQuestion } = await loadSource("lib/paper-basket.ts");

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
