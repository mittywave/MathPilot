import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssignmentAnswerRecoveryPrompt,
  incompleteAssignmentAnswers,
  mergeAssignmentAnswerRecovery,
  normalizeAssignmentAnswerRecovery,
  normalizeQuestionNumber,
} from "../lib/homework-answer-recovery.mjs";
import { finalizeHomeworkVerdict, isSimpleObjectiveAnswer, normalizeHomeworkAnswer } from "../lib/homework-grading-rules.mjs";

test("normalizes objective homework answers conservatively", () => {
  assert.equal(normalizeHomeworkAnswer("答案：Ａ，C。"), "AC");
  assert.equal(normalizeHomeworkAnswer("✓"), "正确");
  assert.equal(isSimpleObjectiveAnswer("填空题", "-2.5"), true);
  assert.equal(isSimpleObjectiveAnswer("填空题", "$5$"),true);
  assert.equal(normalizeHomeworkAnswer("$5$"),"5");
  assert.equal(isSimpleObjectiveAnswer("填空题", "x²-1"), false);
});

test("auto-finalizes readable objective and subjective answers without confidence-gated review", () => {
  assert.deepEqual(finalizeHomeworkVerdict({ type: "单选题", standardAnswer: "B", studentAnswer: "B", modelVerdict: "correct", confidence: .96, warnings: [], threshold: .9 }), { verdict: "correct", requiresReview: false, confidence: .96 });
  assert.deepEqual(finalizeHomeworkVerdict({ type: "单选题", standardAnswer: "B", studentAnswer: "A", modelVerdict: "incorrect", confidence: .35, warnings: [], threshold: .9 }), { verdict: "incorrect", requiresReview: false, confidence: .35 });
  assert.deepEqual(finalizeHomeworkVerdict({ type: "解答题", standardAnswer: "见解析", studentAnswer: "过程", modelVerdict: "partial", confidence: .61, warnings: [], threshold: .9 }), { verdict: "partial", requiresReview: false, confidence: .61 });
  assert.equal(finalizeHomeworkVerdict({ type: "填空题", standardAnswer: "x²-1", studentAnswer: "x²-1", modelVerdict: "correct", confidence: .52, warnings: [], threshold: .9 }).verdict, "correct");
  assert.equal(finalizeHomeworkVerdict({ type: "解答题", standardAnswer: "见解析", studentAnswer: "", modelVerdict: "incorrect", confidence: .8, warnings: [], threshold: .9 }).verdict, "unreadable");
});

test("recovers missing assignment answers by exact question number and keeps unresolved items blocked", () => {
  assert.equal(normalizeQuestionNumber("第 19 题"), "19");
  const questions = [
    { question_number: "19", page_number: 11, type: "解答题", stem: "解方程 3x-1=5(x+1)", options: [], answer: "", analysis: "", bbox: null, confidence: .96, warnings: ["答案页未包含第19题的参考答案与解析"] },
    { question_number: "20", page_number: 11, type: "解答题", stem: "解下列方程", options: [], answer: "", analysis: "", bbox: null, confidence: .95, warnings: [] },
    { question_number: "21", page_number: 11, type: "解答题", stem: "另一道题", options: [], answer: "", analysis: "", bbox: null, confidence: .94, warnings: [] },
  ];
  const recovered = normalizeAssignmentAnswerRecovery({ answers: [
    { question_number: "第19题", answer: "x=-3", analysis: "移项并合并同类项", confidence: .98, warnings: [] },
    { question_number: "20", answer: "x=1", analysis: "去分母后求解", confidence: .97, warnings: [] },
  ] });
  const merged = mergeAssignmentAnswerRecovery(questions, recovered);
  assert.equal(merged[0].answer, "x=-3");
  assert.equal(merged[0].analysis, "移项并合并同类项");
  assert.deepEqual(merged[0].warnings, []);
  assert.equal(merged[1].answer, "x=1");
  assert.equal(merged[1].analysis, "去分母后求解");
  assert.match(merged[2].warnings.join(""), /答案页未包含第21题/);
  assert.equal(incompleteAssignmentAnswers(merged).map((item) => item.question_number).join(","), "21");
});

test("builds an answer recovery prompt that names the input page range and every pending question", () => {
  const prompt = buildAssignmentAnswerRecoveryPrompt([
    { question_number: "19", stem: "解方程 3x-1=5(x+1)" },
    { question_number: "20", stem: "解下列方程" },
  ], 11, 13);
  assert.match(prompt, /答案文件第 12 至 13 张/);
  assert.match(prompt, /题号 19/);
  assert.match(prompt, /题号 20/);
  assert.match(prompt, /必须各返回一条记录/);
});
