import assert from "node:assert/strict";
import test from "node:test";
import { loadSource } from "./load-source.mjs";

// 智能组卷 rules that need no model: how a question's calculation is read, how a focus maps onto it, and how the model's
// answer is checked and completed.
const contract = await loadSource("lib/smart-paper-contract.ts");
const { questionFeatures, focusFeatures, assembleSmartPaperPlan, normalizeSmartPaperBriefResult, normalizeSmartPaperPlan, buildSmartPaperSelectPrompt } = contract;

test("features are read from the calculation itself", () => {
  assert.deepEqual(questionFeatures("$(-6)\\div(-\\frac{1}{3})^{2}-7^{2}+2\\times(-3)^{2}$"), ["分数", "乘方", "除法"], "2×(−3)² multiplies a number, not a sum");
  assert.ok(questionFeatures("$14-(-12)+(-25)-17$").includes("括号前负号"));
  assert.ok(questionFeatures("$(\\frac{1}{4}+\\frac{5}{6}-\\frac{1}{2})\\times 12$").includes("分配律形式"));
  assert.ok(questionFeatures("$\\frac{6}{5}\\times (-\\frac{2}{3})+\\frac{6}{5}\\times (+\\frac{17}{3})$").includes("分配律形式"), "a common factor");
  assert.ok(questionFeatures("$5\\frac{1}{4}-(-2\\frac{2}{3})$").includes("带分数"));
  assert.ok(questionFeatures("$\\left\\{-3\\div 2\\right\\}$").includes("多层括号"));
  assert.ok(questionFeatures("$2(x^2-5x)-3(\\frac{1}{2}x-3)$").includes("含字母"));
  assert.ok(!questionFeatures("$|\\pi-4|$").includes("含字母"), "\\pi is not a letter");
  assert.deepEqual(questionFeatures("已知 3 < x"), [], "only formulas count");
});

test("complexity grows with operations, fractions and brackets", () => {
  const { questionComplexity } = contract;
  assert.equal(questionComplexity("$8-(-2)$"), 1);
  assert.equal(questionComplexity("$(\\frac{1}{6}-\\frac{1}{4}-\\frac{3}{8})\\times(-12)$"), 3);
  assert.ok(questionComplexity("$\\left\\{-3\\div\\left(-1\\frac{1}{2}\\right)^{2}-2^{2}\\times0.125\\times\\left[(-1)^{3}\\div\\frac{4}{3}+\\frac{11}{22}\\right]\\right\\}\\div\\left[2\\times\\left(-\\frac{1}{2}\\right)^{2}-1\\right]$") >= 4);
});

test("a focus names the features that train it", () => {
  assert.deepEqual(focusFeatures({ label: "去括号" }), ["括号前负号", "多层括号"]);
  assert.deepEqual(focusFeatures({ label: "通分约分" }), ["分数", "带分数"]);
  assert.deepEqual(focusFeatures({ label: "乘法分配律" }), ["分配律形式"]);
  assert.deepEqual(focusFeatures({ label: "审题" }), []);
});

test("the brief keeps only categories the outline offered", () => {
  const { brief, findings } = normalizeSmartPaperBriefResult({
    title: "刘羽汐 · 计算打卡", days: 5, per_day: 10, category_ids: ["calc-rational-mixed", "invented"], question_types: ["解答题", "作文"],
    difficulty: "由易到难", focus: [{ label: "去括号", description: "括号前是负号" }], findings: [{ label: "计算", evidence: "计算类错误 37 次" }],
  }, new Set(["calc-rational-mixed"]));
  assert.deepEqual(brief.categoryIds, ["calc-rational-mixed"]);
  assert.deepEqual(brief.questionTypes, ["解答题"]);
  assert.equal(brief.perDay, 10);
  assert.equal(findings[0].evidence, "计算类错误 37 次");
});

const candidate = (n, difficulty, features) => ({ id: `id-${n}`, code: String(n).padStart(4, "0"), difficulty, level: { 基础: 1, 中等: 3, 提高: 5 }[difficulty], stem: `$${n}$`, features });
const candidates = [
  candidate(1, "基础", ["括号前负号"]), candidate(2, "中等", ["分数"]), candidate(3, "基础", ["分数"]), candidate(4, "提高", []),
  candidate(5, "基础", ["乘方"]), candidate(6, "中等", ["括号前负号"]),
];
const brief = { title: "打卡", days: 2, perDay: 3, categoryIds: ["c"], questionTypes: [], difficulty: "", focus: [{ label: "去括号", description: "" }, { label: "通分", description: "" }] };

test("the model's answer is checked: unknown and repeated codes go, days are cut to size and short days filled", () => {
  const selection = { days: [
    { theme: "热身", items: [{ code: "0001", focus: "去括号", reason: "负号" }, { code: "9999", focus: "", reason: "编造的题" }, { code: "0001", focus: "", reason: "重复" }, { code: "ID 0002", focus: "通分", reason: "分母不同" }, { code: "0003", focus: "通分", reason: "" }, { code: "0005", focus: "", reason: "超出" }] },
    { theme: "提高", items: [{ code: "0003", focus: "", reason: "上一天用过" }] },
  ] };
  const plan = assembleSmartPaperPlan({ request: "出题", studentId: "s1", brief, findings: [], avoided: 2, selection, candidates });
  assert.deepEqual(plan.groups.map((group) => group.items.map((item) => item.id)), [["id-1", "id-2", "id-3"], ["id-6", "id-5", "id-4"]]);
  assert.equal(plan.groups[0].theme, "热身");
  assert.equal(plan.groups[1].items[0].reason, "系统补选：式子含括号前负号", "filled with the focus first");
  assert.equal(plan.groups[1].items[2].reason, "系统补选");
  assert.deepEqual(normalizeSmartPaperPlan(plan), plan, "an assembled plan is a valid stored plan");
});

test("the select prompt lists candidates by code and carries the previous plan when revising", () => {
  const prompt = buildSmartPaperSelectPrompt({ brief, candidates: candidates.slice(0, 2), current: [{ theme: "热身", codes: ["0001"] }], instruction: "第 2 天难一点" });
  assert.match(prompt, /0001｜基础｜繁度1｜括号前负号｜\$1\$/);
  assert.match(prompt, /第 1 天（热身）：0001/);
  assert.match(prompt, /第 2 天难一点/);
});
