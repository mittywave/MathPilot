import assert from "node:assert/strict";
import test from "node:test";
import { ALEVEL_PAGE_COPY, alevelPageLabel, alevelQuestionCount, alevelTagVersions, isAlevel9709ModuleName, localizeAlevelTags } from "../lib/alevel-page-locale.mjs";

test("recognizes Alevel 9709 modules without depending on a database id", () => {
  assert.equal(isAlevel9709ModuleName("Alevel 9709"), true);
  assert.equal(isAlevel9709ModuleName("A Level-9709"), true);
  assert.equal(isAlevel9709ModuleName("深圳中考"), false);
});

test("provides concise English labels while preserving stored Chinese values", () => {
  assert.equal(alevelPageLabel("解答题", "en"), "Structured Question");
  assert.equal(alevelPageLabel("中等", "en"), "Intermediate");
  assert.equal(alevelPageLabel("解答题", "zh"), "解答题");
  assert.equal(alevelQuestionCount(1, "en"), "1 question");
  assert.equal(alevelQuestionCount(2, "en"), "2 questions");
  assert.equal(ALEVEL_PAGE_COPY.en.showSolution, "View Solution");
  assert.equal(ALEVEL_PAGE_COPY.en.addWrong, "Save Mistake");
  assert.equal(ALEVEL_PAGE_COPY.zh.showSolution, "查看解析");
});

test("localizes and deduplicates legacy Alevel topic tags", () => {
  const question = { tags: ["三角函数应用", "Modelling with Trigonometric Functions", "modelling  with-trigonometric functions"] };
  assert.deepEqual(localizeAlevelTags(question, "zh"), ["三角函数应用"]);
  assert.deepEqual(localizeAlevelTags(question, "en"), ["Modelling with Trigonometric Functions"]);
});

test("fills both display languages for known legacy Chinese tags", () => {
  const question = { tags: ["一元二次方程", "根的判别式"] };
  assert.deepEqual(localizeAlevelTags(question, "zh"), ["一元二次方程", "根的判别式"]);
  assert.deepEqual(localizeAlevelTags(question, "en"), ["Quadratic Equations", "The Discriminant"]);
});

test("prefers the bilingual versions saved during question entry", () => {
  const question = { tags: ["旧标签"], tagsZh: ["数列", " 数列 "], tagsEn: ["Sequences", "sequences"] };
  assert.deepEqual(alevelTagVersions(question), { zh: ["数列"], en: ["Sequences"] });
  assert.deepEqual(localizeAlevelTags(question, "zh"), ["数列"]);
  assert.deepEqual(localizeAlevelTags(question, "en"), ["Sequences"]);
});

test("keeps unknown legacy tags only in their detected language", () => {
  const question = { tags: ["复数", "Complex Numbers"] };
  assert.deepEqual(alevelTagVersions(question), { zh: ["复数"], en: ["Complex Numbers"] });
});
