import assert from "node:assert/strict";
import test from "node:test";
import { isDocxOptionBlock, normalizedDocxPageLookup, splitDocxOptionBlocks } from "../lib/docx-import-rules.mjs";
import { crossPageRepeat, numberedImportTarget, orderedImportTimestamp, retainedQuestionCreatedAt } from "../lib/question-order-rules.mjs";

test("splits four DOCX options stored in one paragraph", () => {
  assert.deepEqual(splitDocxOptionBlocks(["A．1 B．2 C．3 D．4"]), ["1", "2", "3", "4"]);
  assert.deepEqual(splitDocxOptionBlocks(["A．+35mVB．-35mVC．+30mVD．+70mV"]), ["+35mV", "-35mV", "+30mV", "+70mV"]);
});

test("collects DOCX options across two or four paragraphs", () => {
  assert.deepEqual(splitDocxOptionBlocks(["A．甲 B．乙", "C．丙 D．丁"]), ["甲", "乙", "丙", "丁"]);
  assert.deepEqual(splitDocxOptionBlocks(["A．甲", "B．乙", "C．丙", "D．丁"]), ["甲", "乙", "丙", "丁"]);
});

test("classifies only leading option blocks so options can be removed from the stem", () => {
  const blocks = ["1．下列结论正确的是（　　）", "补充条件 A 不等于零。", "A．甲 B．乙", "C．丙 D．丁"];
  const optionBlocks = blocks.filter(isDocxOptionBlock);
  assert.deepEqual(optionBlocks, ["A．甲 B．乙", "C．丙 D．丁"]);
  assert.deepEqual(blocks.filter((block) => !optionBlocks.includes(block)), ["1．下列结论正确的是（　　）", "补充条件 A 不等于零。"]);
});

test("normalizes the complete rendered page and lets the caller shorten only the lookup key", () => {
  const prefix = "这是超过四十八个字符的题干".repeat(5);
  const suffix = "唯一页尾标记";
  const normalized = normalizedDocxPageLookup(`${prefix}，${suffix}`);
  assert.ok(normalized.length > 48);
  assert.ok(normalized.endsWith(suffix));
  assert.equal(normalizedDocxPageLookup(` $x^2$ ${prefix}，${suffix}`), normalized);
});

test("keeps document order when concurrently saved questions are sorted newest first", () => {
  const startedAt = 2_000_000;
  const timestamps = Array.from({ length: 20 }, (_, index) => orderedImportTimestamp(startedAt, index));
  assert.deepEqual([...timestamps].sort((a, b) => b - a), timestamps);
  assert.equal(retainedQuestionCreatedAt(timestamps[19], startedAt), timestamps[19]);
  assert.equal(retainedQuestionCreatedAt(0, startedAt), startedAt);
  assert.equal(retainedQuestionCreatedAt(startedAt + 1, startedAt), startedAt);
});

test("sections that restart their numbering keep every question; only a page-break repeat is suspect", () => {
  // S8 寒创讲义 pages 3–4: 例题精练 1–3 on each page, read as bare numbers.
  const last = { pageNumber: 1, type: "解答题", number: "3" };
  assert.equal(crossPageRepeat(last, { pageNumber: 2, type: "解答题", number: "1" }, true), false);
  assert.equal(crossPageRepeat(last, { pageNumber: 2, type: "解答题", number: "3" }, true), true, "the next page starts with the same question");
  assert.equal(crossPageRepeat(last, { pageNumber: 2, type: "解答题", number: "3" }, false), false, "only the first question of a page");
  assert.equal(crossPageRepeat(last, { pageNumber: 3, type: "解答题", number: "3" }, true), false, "pages must be adjacent");
  assert.equal(crossPageRepeat(last, { pageNumber: 2, type: "填空题", number: "3" }, true), false);
  assert.equal(crossPageRepeat({ ...last, number: "" }, { pageNumber: 2, type: "解答题", number: "" }, true), false);
  assert.equal(crossPageRepeat(undefined, { pageNumber: 1, type: "解答题", number: "1" }, true), false);
});

test("answers go to the one question with that number, never to the first of several", () => {
  const items = [{ documentNumber: "1", selected: true }, { documentNumber: "2", selected: true }, { documentNumber: "1", selected: true }, { documentNumber: "2", selected: false }];
  assert.deepEqual(numberedImportTarget(items, "2"), { target: items[1], clash: [] }, "an unselected page-break repeat does not count");
  assert.deepEqual(numberedImportTarget(items, "1"), { target: undefined, clash: [items[0], items[2]] });
  assert.deepEqual(numberedImportTarget(items, "3"), { target: undefined, clash: [] });
  assert.deepEqual(numberedImportTarget([{ documentNumber: "", selected: true }], ""), { target: undefined, clash: [] });
});
