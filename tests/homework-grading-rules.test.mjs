import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadSource } from "./load-source.mjs";
import { finalizeHomeworkVerdict, isPendingGradingItem, isSimpleObjectiveAnswer, normalizeHomeworkAnswer, reconcileHomeworkScore, summarizeHomeworkScore, homeworkQuestionLabel, titleWithoutStudent } from "../lib/homework-grading-rules.mjs";

test("school distribution shares whole-question states with the sheet and keeps exam step marks separate", async () => {
  const { resultState, VerdictTally } = await loadSource("app/components/AssignedHomeworkSheet.tsx");
  const correct = { verdict: "correct", requiresReview: false, teacherMark: null, standardAnswer: "5", referenceVerified: true, wasIncorrect: false };
  const partial = { ...correct, verdict: "partial" };
  const corrected = { ...correct, wasIncorrect: true };
  const pending = { ...partial, requiresReview: true, wasIncorrect: true };
  assert.deepEqual([correct, partial, corrected, pending, null].map((item) => resultState(item)), ["correct", "incorrect", "corrected", "pending", "missing"]);
  assert.equal(resultState({ ...partial, wasIncorrect: true }), "incorrect");
  const html = renderToStaticMarkup(createElement(VerdictTally, { items: [correct, partial, corrected, pending, null], total: 5 }));
  for (const [state, label] of [["correct", "正确"], ["incorrect", "错误（待订正）"], ["corrected", "已订正"]]) assert.ok(html.includes(`<div class="${state}"><dt>${label}</dt><dd>1</dd>`), label);
  assert.equal((html.match(/<dt>/g) ?? []).length, 3);
  assert.doesNotMatch(html, /部分正确|<dt>待处理/);
  assert.match(html, /待核实 1 道 · 未交 1 道/);
  assert.equal((html.match(/width:33\.33333333333333%/g) ?? []).length, 3, "only confirmed questions enter the distribution");
  const exam = renderToStaticMarkup(createElement(VerdictTally, { items: [correct, partial, pending], total: 3, international: true }));
  assert.match(exam, /<dt>部分正确<\/dt><dd>1<\/dd>/);
  assert.equal((exam.match(/<dt>/g) ?? []).length, 4);
});

test("current mistake export follows the whole sheet's latest results, including partial answers", async () => {
  const { AssignedHomeworkSheet } = await loadSource("app/components/AssignedHomeworkSheet.tsx");
  const settled = { verdict: "incorrect", requiresReview: false, teacherMark: null, standardAnswer: "5", referenceVerified: true, wasIncorrect: false, submissionId: "new-upload" };
  const results = [
    { ...settled, submissionId: "original-upload" }, { ...settled, verdict: "partial" },
    { ...settled, verdict: "correct", wasIncorrect: true }, { ...settled, verdict: "correct" },
    { ...settled, requiresReview: true }, { ...settled, referenceVerified: false }, null,
  ];
  const assigned = {
    days: [{ title: "第 1 天", size: 4, done: 4, correct: 2, firstAttempt: { correct: 1, incorrect: 3, pending: 0 } }, { title: "第 2 天", size: 3, done: 2, correct: 0, firstAttempt: { correct: 0, incorrect: 0, pending: 2 } }],
    questions: results.map((result, index) => ({ id: `q${index}`, number: String(index + 1), question: { stem: "原题" }, result })),
    uploads: [{ id: "original-upload", status: "published", version: 1 }, { id: "new-upload", status: "published", version: 2 }],
  };
  const props = { submission: { id: "original-upload", assigned }, busy: false, onExport: () => {} };
  const html = renderToStaticMarkup(createElement(AssignedHomeworkSheet, props));
  const busy = renderToStaticMarkup(createElement(AssignedHomeworkSheet, { ...props, busy: true }));
  const corrected = { ...assigned, questions: assigned.questions.map((question) => question.result && !question.result.requiresReview ? { ...question, result: { ...question.result, verdict: "correct", wasIncorrect: true } } : question) };
  const completed = renderToStaticMarkup(createElement(AssignedHomeworkSheet, { ...props, submission: { ...props.submission, assigned: corrected } }));
  for (const format of ["Word", "PDF"]) {
    assert.match(html, new RegExp(`<button type="button" title="导出当前仍需订正的 2 道题为 ${format}，不含答案">导出错题 ${format}</button>`));
    assert.match(busy, new RegExp(`<button type="button" disabled="" title="导出当前仍需订正的 2 道题为 ${format}，不含答案">导出错题 ${format}</button>`));
    assert.match(completed, new RegExp(`<button type="button" disabled="" title="当前没有需要订正的错题">导出错题 ${format}</button>`));
  }
});

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

test("day captions keep first-attempt marks after every mistake is corrected", async () => {
  const { dayNote } = await loadSource("app/components/AssignedHomeworkSheet.tsx");
  const task = { title: "第 1 天", size: 10, done: 10, correct: 10, incorrect: 0, pending: 0, handedInAt: 1_760_400_000_000, firstAttempt: { correct: 5, incorrect: 5, pending: 0 } };
  assert.match(dayNote(task), /首交对 5\/10/);
  assert.doesNotMatch(dayNote(task), /对 10\/10/);
  assert.equal(dayNote({ ...task, correct: 5, incorrect: 5 }), dayNote(task), "regrading changes the current status, not the original caption");
  assert.equal(dayNote({ ...task, done: 0 }), "未提交");
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


test("list titles remove only a leading student name and its separator", () => {
  for (const separator of [" · ", "·", "-", "－", "：", ":", " ", "  "]) {
    assert.equal(titleWithoutStudent(`刘羽汐${separator}有理数练习`, "刘羽汐"), "有理数练习", separator);
  }
  assert.equal(titleWithoutStudent("Alisa · 多项式加法", "Alisa"), "多项式加法");
  assert.equal(titleWithoutStudent("Mary Jane · Practice", "Mary Jane"), "Practice");
  assert.equal(titleWithoutStudent("A+B.(1)[x] · Practice", "A+B.(1)[x]"), "Practice");
  assert.equal(titleWithoutStudent("Eric - -2 的计算", "Eric"), "-2 的计算");
  for (const title of ["Eric有理数练习", "周练 · Eric · 有理数", "Erica · Practice", "eric · Practice", "Eric", "Eric ·", "Eric—Practice", "  Eric · Practice"]) {
    assert.equal(titleWithoutStudent(title, "Eric"), title, title);
  }
  for (const name of [undefined, null, "", "  "]) assert.equal(titleWithoutStudent("普通练习", name), "普通练习");
});
