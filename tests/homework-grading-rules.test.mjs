import assert from "node:assert/strict";
import test from "node:test";
import { finalizeHomeworkVerdict, isPendingGradingItem, isSimpleObjectiveAnswer, normalizeHomeworkAnswer, reconcileHomeworkScore, summarizeHomeworkScore, homeworkQuestionLabel } from "../lib/homework-grading-rules.mjs";

test("pending counts separate unsettled answers from the teacher's existing judgement", () => {
  const settled = { verdict: "incorrect", requiresReview: false, teacherMark: null, standardAnswer: "5", referenceVerified: true };
  for (const [patch, expected] of [
    [{}, false],
    [{ verdict: "correct", standardAnswer: "", referenceVerified: false }, false],
    [{ standardAnswer: "" }, true],
    [{ referenceVerified: false }, true],
    [{ referenceVerified: undefined }, true],
    [{ verdict: "partial", standardAnswer: "" }, true],
    [{ verdict: "partial", referenceVerified: false }, true],
    [{ verdict: "partial" }, false],
    ...["correct", "partial", "incorrect"].map((teacherMark) => [{ teacherMark, standardAnswer: "", referenceVerified: false }, false]),
    [{ teacherMark: "incorrect", requiresReview: true }, true],
    [{ verdict: "correct", teacherMark: "correct", requiresReview: true }, true],
    [{ verdict: "unreadable", teacherMark: "correct" }, true],
    [{ verdict: "review_required", teacherMark: "incorrect" }, true],
  ]) assert.equal(isPendingGradingItem({ ...settled, ...patch }), expected, JSON.stringify(patch));
});

test("normalizes objective homework answers conservatively", () => {
  assert.equal(normalizeHomeworkAnswer("答案：Ａ，C。"), "AC");
  assert.equal(normalizeHomeworkAnswer("✓"), "正确");
  assert.equal(isSimpleObjectiveAnswer("填空题", "-2.5"), true);
  assert.equal(isSimpleObjectiveAnswer("填空题", "$5$"),true);
  assert.equal(normalizeHomeworkAnswer("$5$"),"5");
  assert.equal(isSimpleObjectiveAnswer("填空题", "x²-1"), false);
});

test("auto-finalizes readable objective and subjective answers without confidence-gated review", () => {
  assert.deepEqual(finalizeHomeworkVerdict({ type: "单选题", standardAnswer: "B", studentAnswer: "B", modelVerdict: "correct", confidence: .96, warnings: [], threshold: .9 }), { verdict: "correct", score: null, requiresReview: false, confidence: .96 });
  assert.deepEqual(finalizeHomeworkVerdict({ type: "单选题", standardAnswer: "B", studentAnswer: "A", modelVerdict: "incorrect", confidence: .35, warnings: [], threshold: .9 }), { verdict: "incorrect", score: null, requiresReview: false, confidence: .35 });
  assert.deepEqual(finalizeHomeworkVerdict({ type: "解答题", standardAnswer: "见解析", studentAnswer: "过程", modelVerdict: "partial", confidence: .61, warnings: [], threshold: .9 }), { verdict: "partial", score: null, requiresReview: false, confidence: .61 });
  assert.equal(finalizeHomeworkVerdict({ type: "填空题", standardAnswer: "x²-1", studentAnswer: "x²-1", modelVerdict: "correct", confidence: .52, warnings: [], threshold: .9 }).verdict, "correct");
  assert.equal(finalizeHomeworkVerdict({ type: "解答题", standardAnswer: "见解析", studentAnswer: "", modelVerdict: "incorrect", confidence: .8, warnings: [], threshold: .9 }).verdict, "unreadable");
});

test("scores follow printed marks and stay consistent with the verdict", () => {
  assert.equal(finalizeHomeworkVerdict({ type: "单选题", standardAnswer: "B", studentAnswer: "B", modelVerdict: "incorrect", confidence: .9, maxScore: 3 }).score, 3);
  assert.equal(finalizeHomeworkVerdict({ type: "填空题", standardAnswer: "5", studentAnswer: "", answerState: "blank", modelVerdict: "incorrect", confidence: 1, maxScore: 2 }).score, 0);
  assert.deepEqual(finalizeHomeworkVerdict({ type: "解答题", standardAnswer: "见解析", studentAnswer: "过程", modelVerdict: "correct", modelScore: 2.4, confidence: .8, maxScore: 4 }), { verdict: "partial", score: 2.5, requiresReview: false, confidence: .8 });
  assert.equal(finalizeHomeworkVerdict({ type: "解答题", standardAnswer: "见解析", studentAnswer: "看不清", modelVerdict: "unreadable", modelScore: 2, confidence: .2, maxScore: 4 }).score, null);
  assert.deepEqual(reconcileHomeworkScore("partial", 9, 5), { verdict: "correct", score: 5 });
  assert.deepEqual(reconcileHomeworkScore("partial", null, 5), { verdict: "partial", score: null });
  assert.deepEqual(reconcileHomeworkScore("correct", 3, null), { verdict: "correct", score: null });
});

test("IGCSE / A Level counts an unreadable answer as 0 marks while school marking leaves it pending", () => {
  assert.deepEqual(reconcileHomeworkScore("unreadable", null, 3, "international"), { verdict: "unreadable", score: 0 });
  assert.deepEqual(reconcileHomeworkScore("unreadable", null, 3), { verdict: "unreadable", score: null });
  assert.deepEqual(reconcileHomeworkScore("review_required", null, 3, "international"), { verdict: "review_required", score: null });
  const graded = finalizeHomeworkVerdict({ type: "解答题", standardAnswer: "见解析", studentAnswer: "看不清", modelVerdict: "unreadable", confidence: .2, maxScore: 4, curriculum: "international" });
  assert.deepEqual([graded.verdict, graded.score, graded.requiresReview], ["unreadable", 0, true], "it still waits for a clearer photo");
  assert.deepEqual(summarizeHomeworkScore([{ score: 0, maxScore: 3, requiresReview: true }, { score: 2, maxScore: 2, requiresReview: false }]), { score: 2, maxScore: 5, pending: 0, percentage: 40 });
});

test("a total keeps every question in the denominator and leaves the percentage open while any is pending", () => {
  const items = [{ score: 3, maxScore: 3, requiresReview: false }, { score: 1, maxScore: 4, requiresReview: false }, { score: null, maxScore: 5, requiresReview: true }];
  assert.deepEqual(summarizeHomeworkScore(items), { score: 4, maxScore: 12, pending: 1, percentage: null });
  assert.deepEqual(summarizeHomeworkScore(items.slice(0, 2)), { score: 4, maxScore: 7, pending: 0, percentage: 57.1 });
  assert.equal(summarizeHomeworkScore([...items, { score: null, maxScore: null, requiresReview: false }]), null);
});

test("school questions read as page and printed number, sub-questions keep their part, and a paper keeps its own numbers", () => {
  assert.equal(homeworkQuestionLabel("1-3"), "第 1 面 第 3 题");
  assert.equal(homeworkQuestionLabel("13-12"), "第 13 面 第 12 题");
  assert.equal(homeworkQuestionLabel("1-3(2)"), "第 1 面 第 3 题 (2)");
  assert.equal(homeworkQuestionLabel("3(b)(ii)"), "第 3(b)(ii) 题");
  assert.equal(homeworkQuestionLabel("D1"), "第 D1 题");
});
