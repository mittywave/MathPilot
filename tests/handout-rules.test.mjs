import test from "node:test";
import assert from "node:assert/strict";
import { chineseNumeral, ensureLeadingModule, handoutModules, handoutNumbers, handoutSections, insertIndexForSection, moduleHeading, moveHandoutItem, normalizeHandoutDraft, normalizePlacement, placementLabel, questionPoints, setItemBand } from "../lib/handout-rules.mjs";

const q = (id, band = "example", questionId = id, scope = "mine") => ({ id, kind: "question", scope, questionId, band });
const s = (id, title = id, note = "") => ({ id, kind: "section", title, note });
const ids = list => list.map(item => item.id);

test("normalization keeps valid items, defaults the band and drops malformed or repeated ones", () => {
  const draft = normalizeHandoutDraft({
    title: "   ",
    items: [q("a"), q("a", "practice", "other"), { id: "b", kind: "question", scope: "everyone", questionId: "x" }, { id: "c", kind: "text" },
      { id: "", kind: "section", title: "无编号" }, s("d", "一、例题".repeat(100), "说明".repeat(12000)), q("e", "variant", "", "public"),
      { id: "legacy", kind: "question", scope: "public", questionId: "q-1" }, q("odd", "homework"), null],
  });
  assert.equal(draft.title, "未命名讲义");
  assert.deepEqual(ids(draft.items), ["a", "d", "legacy", "odd"]);
  assert.equal(draft.items[0].questionId, "a");
  assert.equal(draft.items[1].title.length, 200);
  assert.equal(draft.items[1].note.length, 20_000);
  assert.equal(draft.items[2].band, "example", "questions saved before bands read as 例题");
  assert.equal(draft.items[3].band, "example", "unknown bands fall back to 例题");
  assert.equal(normalizeHandoutDraft({ title: "x".repeat(200) }).title.length, 120);
  assert.equal(normalizeHandoutDraft({ items: Array.from({ length: 500 }, (_, i) => q(`i${i}`)) }).items.length, 400);
  assert.deepEqual(normalizeHandoutDraft(null), { title: "未命名讲义", items: [] });
});

test("modules group their questions by band and each band numbers on across modules", () => {
  const items = [s("m1", "平行四边形的性质", "对边相等"), q("p1", "practice"), q("e1"), q("v1", "variant"), q("e2"), s("m2", "判定"), q("e3"), q("p2", "practice")];
  const modules = handoutModules(items);
  assert.equal(modules[0].section, null);
  assert.deepEqual(Object.fromEntries(Object.entries(modules[1].bands).map(([band, list]) => [band, ids(list)])), { example: ["e1", "e2"], practice: ["p1"], variant: ["v1"] });
  assert.deepEqual(Object.fromEntries(handoutNumbers(items)), { e1: "例1", e2: "例2", p1: "1", v1: "变式1", e3: "例3", p2: "2" });

  const bank = new Map(["e1", "e2", "e3", "p1", "v1"].map(id => [`mine:${id}`, { id }]));
  const result = handoutSections(items, (scope, id) => bank.get(`${scope}:${id}`));
  assert.deepEqual(result.modules.map(module => [module.heading, module.note, ids(module.bands.example), ids(module.bands.practice), ids(module.bands.variant)]), [
    ["平行四边形的性质", "对边相等", ["e1", "e2"], ["p1"], ["v1"]],
    ["判定", "", ["e3"], [], []],
  ]);
  assert.equal(result.missingCount, 1, "p2 is gone from the library");
  assert.deepEqual(handoutSections([q("lead")], (scope, id) => ({ id })).modules.map(module => module.heading), [""], "questions before any module still export");
});

test("questions move inside their band; modules move with all their questions", () => {
  const items = [s("m1"), q("e1"), q("p1", "practice"), q("e2"), q("p2", "practice"), s("m2"), q("e3")];
  assert.deepEqual(ids(moveHandoutItem(items, "e2", -1)), ["m1", "e2", "p1", "e1", "p2", "m2", "e3"], "skips the 练习 in between");
  assert.equal(moveHandoutItem(items, "e1", -1), items, "first 例题 stays first");
  assert.equal(moveHandoutItem(items, "e2", 1), items, "never leaks into the next module");
  assert.equal(moveHandoutItem(items, "e3", -1), items);
  assert.deepEqual(ids(moveHandoutItem(items, "m2", -1)), ["m2", "e3", "m1", "e1", "p1", "e2", "p2"]);
  assert.equal(moveHandoutItem(items, "m1", -1), items);
  assert.equal(moveHandoutItem(items, "missing", 1), items);
  assert.deepEqual(ids(items), ["m1", "e1", "p1", "e2", "p2", "m2", "e3"], "the original list is not mutated");
});

test("a question can change band; new questions go to the end of their module", () => {
  const items = [q("a"), s("m1"), q("b"), s("m2")];
  assert.equal(setItemBand(items, "b", "variant")[2].band, "variant");
  assert.equal(setItemBand(items, "b", "homework"), items);
  assert.equal(setItemBand(items, "b", "example"), items, "same band changes nothing");
  assert.equal(setItemBand(items, "m1", "practice"), items, "modules have no band");
  const lane = [s("m1"), q("e1"), q("p1", "practice"), q("e2"), s("m2"), q("x")];
  const changed = setItemBand(lane, "e1", "practice");
  assert.deepEqual(ids(changed), ["m1", "p1", "e2", "e1", "m2", "x"], "joins the end of 练习 in the same module");
  assert.deepEqual(ids(handoutModules(changed)[1].bands.practice), ["p1", "e1"]);
  assert.deepEqual(ids(setItemBand([q("lead"), q("lead2"), s("m1")], "lead", "variant")), ["lead2", "lead", "m1"]);
  assert.equal(insertIndexForSection(items, null), 1);
  assert.equal(insertIndexForSection(items, "m1"), 3);
  assert.equal(insertIndexForSection(items, "m2"), 4);
  assert.equal(insertIndexForSection(items, "missing"), 4);
  assert.equal(insertIndexForSection([], null), 0);
});

test("module headings are numbered by position without doubling a typed number", () => {
  assert.deepEqual(moduleHeading("一、平行四边形的性质", 0), { numeral: "一", title: "平行四边形的性质" });
  assert.deepEqual(moduleHeading("模块二：判定", 1), { numeral: "二", title: "判定" });
  assert.deepEqual(moduleHeading("2. 判定", 1), { numeral: "二", title: "判定" });
  assert.deepEqual(moduleHeading("1.5 倍关系", 0), { numeral: "一", title: "1.5 倍关系" });
  assert.deepEqual(moduleHeading("", 10), { numeral: "十一", title: "" });
  assert.deepEqual([1, 10, 12, 20, 23].map(chineseNumeral), ["一", "十", "十二", "二十", "二十三"]);
});

test("考点 come from the question's own knowledge tags", () => {
  assert.deepEqual(questionPoints({ tags: ["平行四边形的性质", " ", "平行四边形的性质", "勾股定理", "全等", "相似"] }), ["平行四边形的性质", "勾股定理", "全等"]);
  assert.deepEqual(questionPoints({ tags: ["Trigonometry"], tagsZh: ["三角函数"] }), ["三角函数"]);
  assert.deepEqual(questionPoints({}), []);
});

test("loose questions and empty handouts get a first module", () => {
  assert.deepEqual(ensureLeadingModule([], "new"), [s("new", "", "")]);
  assert.deepEqual(ids(ensureLeadingModule([q("a"), s("m1"), q("b")], "new")), ["new", "a", "m1", "b"]);
  const ready = [s("m1"), q("a")];
  assert.equal(ensureLeadingModule(ready, "new"), ready);
});

test("a placement needs both a known grade and a known term", () => {
  assert.deepEqual(normalizePlacement({ grade: 8, term: "autumn" }), { grade: 8, term: "autumn" });
  assert.deepEqual(normalizePlacement({ grade: "9", term: "summer" }), { grade: 9, term: "summer" }, "a numeric string from a query reads as a grade");
  for (const raw of [null, {}, { grade: 8 }, { term: "spring" }, { grade: 6, term: "spring" }, { grade: 7, term: "fall" }, { grade: null, term: null }]) assert.equal(normalizePlacement(raw), null);
  assert.equal(placementLabel({ grade: 7, term: "winter" }), "初一 · 寒假");
  assert.equal(placementLabel({ grade: null, term: null }), "未归类");
});
