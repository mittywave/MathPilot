import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./load-source.mjs";

const { buildHomeworkReportLatex, buildStudentReportLatex } = await loadSource("lib/homework-report-latex.ts");
const { completeInternationalReport, mainQuestionNumber, normalizeInternationalReport } = await import("../lib/homework-report.mjs");

test("student reports export open ability diagnoses and their source quotes while preserving legacy report text", () => {
  const report = { periodStart: 1792281600000, periodEnd: 1792368000000, data: {
    studentName: "验收学生", className: "", homework: [], knowledge: [], types: [], wrongAdded: 1,
    abilityEvidence: [{ id: "g", title: "四边形证明", questionNumber: "3", version: 1 }],
    abilityAnalysis: { summary: "检查条件", insights: [{ title: "判定条件的完整性", demand: "说明垂直与平分",
      diagnosis: "本次未写垂直条件，原因待验证", status: "hypothesis", evidence: [{ id: "g", quote: "缺少 $MN\\perp BD$" }], nextStep: "补全判定条件" }], limitations: ["没有完整手写过程"] },
  }, text: { overview: "本期样本", knowledge: "", abilities: "原有能力文字", plan: [], message: "" } };
  const tex = buildStudentReportLatex(report);
  assert.match(tex, /判定条件的完整性.*待验证推断/);
  assert.match(tex, /四边形证明.*第 3 题.*第 1 次上传/);
  assert.match(tex, /MN\\perp BD/);
  assert.doesNotMatch(tex, /老师的判断|五项能力|课后反馈/);
  const legacy = buildStudentReportLatex({ ...report, data: { ...report.data, abilityAnalysis: undefined, observations: [{ observedAt: 1792300000000, text: "历史反馈原话" }] } });
  assert.match(legacy, /历史反馈原话/);
  assert.match(legacy, /原有能力文字/);
  assert.doesNotMatch(legacy, /判定条件的完整性/);
});

const item = (questionNumber, score, maxScore, extra = {}) => ({ id: questionNumber, questionNumber, score, maxScore, verdict: score == null ? "review_required" : score === maxScore ? "correct" : score === 0 ? "incorrect" : "partial",
  stem: "", studentAnswer: "", feedback: "", errorType: "", stepAnalysis: [], standardAnswer: "", standardAnalysis: "", ...extra });
const fixture = () => {
  const gradingItems = [item("1(a)", 2, 2), item("1(b)", 2, 5, { feedback: "只求出 $x$，未回代求 $y$。" }), item("2", 4, 4), item("3(a)", 0, 3, { verdict: "unreadable", feedback: "作答看不清，按 0 分计。" }), item("3(b)", null, 2)];
  const details = completeInternationalReport(normalizeInternationalReport({
    overview: "第 1(a)、2 题完成稳定；优先补强方程组回代（第 1(b) 题）。", priorities: ["方程组回代"],
    topics: [{ question: "1", topic: "联立方程", note: "回代不完整。" }, { question: "2", topic: "函数变换", note: "全部正确。" }],
    losses: [{ section: "代数 & 方程", question_numbers: ["1(b)"], title: "求出 $x$ 后没有回代", fact: "已得 $x=7$ 或 $x=-5$，未求 $y$。", knowledge: "知识方法已体现，需补全答案。",
      method: "$$3x+2y=-11 \\Rightarrow y=\\frac{-11-3x}{2}$$\n得 $$\\boxed{(7,-16),\\ (-5,2)}$$", action: "把两个根分别代回一次方程，成对写出解，再代入原方程检验 100%。" }],
    practice: [{ focus: "解答收尾", action: "重做第 1(b) 题，写出 $y$ 的两个值。", standard: "两组解成对写出并代回检验。" }], checklist: "每题结束前检查：问题是否答全？",
  }), gradingItems);
  return { studentName: "Mack_测试", assignmentTitle: "9709 P1 Week 1 #Quiz", submittedAt: Date.UTC(2026, 8, 12), pages: [{}, {}, {}], gradingItems,
    gradingSummary: { marks: { score: 8, maxScore: 16, pending: 1, percentage: null } }, report: { updatedAt: Date.UTC(2026, 9, 6), details } };
};

test("sub-parts roll up to their printed question", () => {
  assert.deepEqual(["3(b)(ii)", "5", "3-1(a)"].map(mainQuestionNumber), ["3", "5", "3-1"]);
});

test("every lost mark reaches the report, and pending sub-parts keep the percentage open", () => {
  const { report } = fixture();
  assert.deepEqual(report.details.losses.map((loss) => loss.questionNumbers), [["1(b)"], ["3(a)"]], "the unreadable sub-part the model left out is added");
  assert.match(report.details.losses[1].knowledge, /无法从看不清的作答判断/);
  assert.deepEqual(report.details.topics.map((topic) => topic.question), ["1", "2", "3"]);
  const tex = buildHomeworkReportLatex(fixture());
  assert.match(tex, /已确认得分[\s\S]*8 \/ 16[\s\S]*待定/);
  assert.match(tex, /第3\(b\)题待补图或核实/);
  assert.match(tex, /^1 & 联立方程 & 4\/7 & /m);
  assert.match(tex, /^3 & — & 0\/5（待核） & /m);
  assert.match(tex, /\\topic\{第1\(b\)题：求出 \$x\$ 后没有回代\}\{2\/5分 · 失3分\}/);
  assert.match(tex, /\\\[3x\+2y=-11 \\Rightarrow y=\\frac\{-11-3x\}\{2\}\\\]/);
  assert.match(tex, /代数 \\& 方程/);
  assert.match(tex, /9709 P1 Week 1 \\#Quiz/);
  assert.match(tex, /100\\%/);
  assert.doesNotMatch(tex, /\b[MAB]1\b/);
});
