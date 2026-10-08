import assert from "node:assert/strict";
import test from "node:test";
import { loadSource } from "./load-source.mjs";

const { normalizeSingleRecognitionResult } = await loadSource("lib/recognition-contract.ts");
const { assignmentQuestionToQuestion } = await loadSource("lib/question-content.ts");

test("library scanning and automatic wrong-book snapshots preserve the same question content", () => {
  for (const raw of [
    { type: "单选题", stem: "计算 $\\frac{1}{2}+\\frac{1}{2}$", options: ["A. 1", "B. 1", "C. 2"], answer: "A", analysis: "通分后相加" },
    { type: "解答题", stem: "（1）解方程\n（2）验算", options: [], answer: "x=2", analysis: "两边同除以 2\n代回原式" },
  ]) {
    const scanned = normalizeSingleRecognitionResult(raw, []);
    const snapshot = assignmentQuestionToQuestion({
      id: "q1", type: scanned.type, stem: scanned.stem, options: scanned.options, answer: scanned.answer, analysis: scanned.analysis,
      pageNumber: 1, knowledgeTags: ["方程"], taxonomyKeys: ["cn-math:topic:linear-equation"], confidence: .98, warnings: [],
    }, { title: "测试作业", createdAt: 1, updatedAt: 2, originalImage: "/api/homework-assets/source" });
    for (const field of ["type", "stem", "options", "answer", "analysis"]) assert.deepEqual(snapshot[field], scanned[field]);
    assert.deepEqual(snapshot.tags, ["方程"]);
    assert.equal(snapshot.originalImage, "/api/homework-assets/source");
    assert.deepEqual(snapshot.taxonomyKeys, ["cn-math:topic:linear-equation"]);
  }
});
