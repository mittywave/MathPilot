import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capabilityGraphPoint, graphDragRotationDelta, graphDragRotationDirections, projectCapabilityGraphPoint, traceCapabilityPath, visibleCapabilityGraph } from "../lib/capability-cloud-layout.mjs";
import { CHINA_MATH_NODES, resolveChinaMathTaxonomyKeys, validateChinaMathTaxonomy } from "../lib/china-curriculum-taxonomy.mjs";
import { buildCapabilityProfile } from "../lib/homework-capability-framework.mjs";
import { buildFallbackSubmissionReport, normalizeSubmissionReport } from "../lib/homework-report.mjs";
import { loadSource } from "./load-source.mjs";
import { migratedDatabase, d1 } from "./helpers/migrated-d1.mjs";

test("open ability dimensions require genuine work quotes, preserve mathematical signs and qualify blank answers", async () => {
  const { normalizeStudentAbilityAnalysis, buildStudentAbilityPrompt } = await loadSource("lib/student-profile-contract.ts");
  const evidence = [{ id: "g1", assignmentQuestionId: "q1", submissionId: "s1", title: "等价变形", version: 1, questionNumber: "2",
    studentAnswer: "-2x=4", feedback: "移项时遗漏负号", stepAnalysis: ["从 x-4=0 变成 x=-4"], errorReasons: [], evidenceSummary: "",
    stem: "解方程 x-4=0", standardAnswer: "x=4", standardAnalysis: "两边加4", verdict: "incorrect" },
  { id: "g2", studentAnswer: "", feedback: "未作答", stepAnalysis: [], errorReasons: [], evidenceSummary: "" }];
  const insight = { title: "等价关系保持与逆运算选择", demand: "每一步保持解集不变", diagnosis: "需要区分概念缺口与执行失误",
    status: "observed", nextStep: "解释每一步等式两边执行的操作", evidence: [{ id: "g1", quote: "-2x=4" }] };
  const result = normalizeStudentAbilityAnalysis({ summary: "含有虚构结论的摘要", insights: [
    insight, { ...insight, evidence: [{ id: "g1", quote: "2x=4" }] },
    { ...insight, evidence: [{ id: "g1", quote: "两边加4" }] },
    { ...insight, evidence: [{ id: "someone-else", quote: "-2x=4" }] },
    { ...insight, evidence: [{ id: "g1", quote: "-2x=4" }, { id: "missing", quote: "无" }] },
    { ...insight, title: "空白原因待验证", evidence: [{ id: "g2", quote: "未作答" }] },
  ] }, evidence);
  // A quote that omits the leading minus is a substring, so quote verification alone cannot prove interpretation;
  // a changed mathematical sign must, however, never pass by punctuation normalization.
  assert.equal(normalizeStudentAbilityAnalysis({ insights: [{ ...insight, evidence: [{ id: "g1", quote: "+2x=4" }] }] }, evidence).insights.length, 0);
  assert.equal(result.insights.length, 3);
  assert.equal(result.insights[0].title, insight.title, "dimensions outside the former five are retained");
  assert.equal(result.insights.at(-1).status, "hypothesis");
  assert.doesNotMatch(result.summary, /虚构结论/);
  assert.match(result.limitations.join(" "), /已舍弃/);
  assert.match(buildStudentAbilityPrompt(evidence, 120), /同一题的多次上传是重复尝试/);
  assert.match(buildStudentAbilityPrompt(evidence, 120), /采样之外的作答未知/);
});

test("ability evidence respects owner, student, publication, review, profile inclusion and period; no fixed graph skills are diagnoses", async t => {
  const sqlite = await migratedDatabase(); t.after(() => sqlite.close());
  sqlite.exec(`
    INSERT INTO users(id,email,password_hash,password_salt,password_iterations,role,created_at) VALUES('u','u@test','h','s',1,'admin',0),('other','other@test','h','s',1,'member',0);
    INSERT INTO students(id,owner_user_id,name,class_name,notes,created_at,updated_at) VALUES('s1','u','甲','','',0,0),('s2','u','乙','','',0,0);
    INSERT INTO homework_assignments(id,owner_user_id,title,status,input_mode,outputs_json,created_at,updated_at) VALUES('a','u','能力证据','closed','completed_homework','{"profile":true}',0,0),('off','u','不计入','closed','completed_homework','{"profile":false}',0,0);
  `);
  let version = 0;
  for (const [id, student, assignment, status, at, review, verified] of [
    ["good", "s1", "a", "published", 100, 0, 1], ["old", "s1", "a", "published", 10, 0, 1],
    ["future", "s1", "a", "published", 300, 0, 1], ["peer", "s2", "a", "published", 100, 0, 1],
    ["draft", "s1", "a", "ready", 100, 0, 1], ["review", "s1", "a", "published", 100, 1, 1],
    ["reference", "s1", "a", "published", 100, 0, 0], ["excluded", "s1", "off", "published", 100, 0, 1],
  ]) {
    sqlite.prepare("INSERT INTO homework_submissions(id,assignment_id,student_id,status,submitted_by_type,submitted_by_id,submitted_at,created_at,updated_at,version) VALUES(?,?,?,?,'teacher','u',?,?,?,?)").run(id,assignment,student,status,at,at,at,++version);
    sqlite.prepare("INSERT INTO assignment_questions(id,assignment_id,question_number,page_number,type,stem,answer,analysis,reference_verified,sort_order,created_at,updated_at) VALUES(?,?,?,1,'填空题','解方程 x-4=0','4','两边加4',?,0,0,0)").run(id,assignment,id,verified);
    sqlite.prepare("INSERT INTO grading_items(id,submission_id,assignment_question_id,verdict,student_answer,feedback,requires_review,created_at,updated_at) VALUES(?,?,?,'incorrect','x=-4','移项时遗漏负号',?,0,0)").run(id,id,id,review);
  }
  const api = await loadSource("lib/server/student-profile.ts", { DB: d1(sqlite) });
  const profile = await api.readStudentProfile("s1", { id: "u" }, 50, 200);
  assert.deepEqual(profile.abilityEvidence.map(item => item.id), ["good"]);
  assert.equal(profile.abilityEvidenceTotal, 1);
  assert.equal(profile.abilityEvidence[0].standardAnalysis, "两边加4");
  assert.equal(profile.observations, undefined);
  await assert.rejects(api.readStudentProfile("s1", { id: "other" }, null), error => error instanceof Response && error.status === 404);
  const before = JSON.stringify(profile.abilityEvidence);
  sqlite.prepare("UPDATE grading_items SET student_answer='x=4',verdict='correct',feedback='订正正确' WHERE id='good'").run();
  const corrected = await api.readStudentProfile("s1", { id: "u" }, 50, 200);
  assert.equal(corrected.abilityEvidence[0].verdict, "correct");
  assert.notEqual(JSON.stringify(corrected.abilityEvidence), before, "a corrected result invalidates the client evidence signature");
});

test("China math taxonomy follows its schema contract and keeps references acyclic", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/china-math-taxonomy.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(validateChinaMathTaxonomy(), []);
  assert.deepEqual(schema.required, ["version", "title", "scope", "status", "nodes", "edges", "editions", "mappings"]);
  assert.equal(new Set(CHINA_MATH_NODES.map((node) => node.key)).size, CHINA_MATH_NODES.length);
  assert.deepEqual(resolveChinaMathTaxonomyKeys(["一元一次方程"]), ["cn-math:topic:linear-equation"]);
  assert.deepEqual(resolveChinaMathTaxonomyKeys(["圆周角与切线"]), ["cn-math:topic:circle"]);
});

test("capability evidence aggregates with time decay", () => {
  const now = 2_000_000_000_000;
  const profile = buildCapabilityProfile([
    { capabilityKey: "skill:calculation", capabilityLabel: "计算准确性", verdict: "correct", confidence: 1, assignmentId: "old", questionNumber: "1", diagnosis: "计算正确", createdAt: now - 200 * 86_400_000 },
    { capabilityKey: "skill:calculation", capabilityLabel: "计算准确性", verdict: "incorrect", confidence: .9, assignmentId: "current", questionNumber: "2", diagnosis: "符号错误", createdAt: now },
    { capabilityKey: "skill:calculation", capabilityLabel: "计算准确性", verdict: "partial", confidence: .8, assignmentId: "current", questionNumber: "3", diagnosis: "检查不足", createdAt: now - 1_000 },
  ], { studentId: "student", now });
  const node = profile.nodes.find((item) => item.key === "skill:calculation");
  assert.equal(node.status, "attention");
  assert.equal(node.evidenceCount, 3);
  assert.equal(profile.nodes.find((item) => item.key === "skill:modeling").status, "insufficient");
  assert.ok(Array.isArray(profile.edges));
});

test("legacy knowledge evidence is merged into stable China curriculum nodes", () => {
  const profile = buildCapabilityProfile([
    { capabilityKey: "knowledge:tag:一元一次方程", capabilityLabel: "一元一次方程", verdict: "incorrect", confidence: .95,
      assignmentId: "a", questionNumber: "2", diagnosis: "移项符号错误", createdAt: 2_000_000_000_000 },
  ], { studentId: "s", now: 2_000_000_000_000 });
  const node = profile.nodes.find((item) => item.key === "cn-math:topic:linear-equation");
  assert.equal(node.evidenceCount, 1);
  assert.equal(node.textbookMappings.length, 3);
  assert.ok(profile.edges.some((edge) => edge.targetKey === "cn-math:topic:linear-equation"));
});

test("teacher framework view contains the complete China curriculum graph without student evidence", () => {
  const profile = buildCapabilityProfile([], { includeAllKnowledge: true, now: 2_000_000_000_000 });
  assert.equal(profile.nodes.filter((node) => node.dimension === "knowledge").length, CHINA_MATH_NODES.length);
  assert.equal(profile.edges.filter((edge) => edge.sourceKey.startsWith("cn-math:")).length, 29);
  assert.ok(profile.nodes.filter((node) => node.dimension === "knowledge").every((node) => node.status === "insufficient"));
});

test("fallback report is concise, deterministic, and normalized to three points", () => {
  const report = buildFallbackSubmissionReport([
    { questionNumber: "1", verdict: "correct", feedback: "步骤清晰", errorType: "", capabilityKeys: [] },
    { questionNumber: "2", verdict: "partial", feedback: "缺少结论", errorType: "步骤", capabilityKeys: ["skill:expression"] },
    { questionNumber: "3", verdict: "incorrect", feedback: "符号错误", errorType: "计算", capabilityKeys: ["skill:calculation"] },
  ], 1234);
  assert.equal(report.strengths.length, 1);
  assert.equal(report.gaps.length, 2);
  assert.ok(report.actions.length <= 3);
  assert.match(report.overallSummary, /3 题/);
  const normalized = normalizeSubmissionReport({ ...report, actions: [...report.actions, "额外一", "额外二"] }, 5678);
  assert.equal(normalized.actions.length, 3);
  assert.equal(normalized.updatedAt, 5678);
});

test("capability graph layout is stable, staged, and keeps projected coordinates finite", () => {
  const gradeSeven = CHINA_MATH_NODES.find((node) => node.key === "cn-math:topic:linear-equation");
  const gradeNine = CHINA_MATH_NODES.find((node) => node.key === "cn-math:topic:quadratic-equation");
  const first = capabilityGraphPoint(gradeSeven, 3, CHINA_MATH_NODES, { dimension: "knowledge" });
  assert.deepEqual(first, capabilityGraphPoint(gradeSeven, 3, CHINA_MATH_NODES, { dimension: "knowledge" }));
  assert.ok(capabilityGraphPoint(gradeNine, 4, CHINA_MATH_NODES, { dimension: "knowledge" }).y > first.y);
  const projected = projectCapabilityGraphPoint(first, { rotationY: -.6, tilt: .2, scaleX: 120, scaleY: 100, centerX: 180, centerY: 150 });
  assert.ok(Number.isFinite(projected.x) && Number.isFinite(projected.y) && Number.isFinite(projected.depth));
  assert.ok(projected.x > 0 && projected.y > 0);
  const pivot = projectCapabilityGraphPoint({ x: 0, y: 0, z: 0 }, { rotationX: .7, rotationY: -1.1, scaleX: 120, scaleY: 100, centerX: 180, centerY: 150 });
  assert.deepEqual(pivot, { x: 180, y: 150, depth: 0 });
  const dragInput = { rotationX: .35, rotationY: -.72, scaleX: 120, scaleY: 100, centerX: 180, centerY: 150 };
  const directions = graphDragRotationDirections(first, dragInput);
  const dragStart = projectCapabilityGraphPoint(first, dragInput);
  const dragRight = projectCapabilityGraphPoint(first, { ...dragInput, rotationY: dragInput.rotationY + directions.rotationY * .01 });
  const dragDown = projectCapabilityGraphPoint(first, { ...dragInput, rotationX: dragInput.rotationX + directions.rotationX * .01 });
  assert.ok(dragRight.x > dragStart.x, "positive horizontal drag must move its anchor right");
  assert.ok(dragDown.y > dragStart.y, "positive vertical drag must move its anchor down");
});

test("jacobian drag keeps anchors moving with the pointer across left and right depths", () => {
  const points = [
    { x: -1.35, y: -.75, z: -.55 },
    { x: -.45, y: .2, z: .42 },
    { x: .35, y: -.15, z: -.5 },
    { x: 1.4, y: .7, z: .48 },
  ];
  const input = { rotationX: .14, rotationY: -.16, scaleX: 225, scaleY: 175, centerX: 388, centerY: 285 };
  for (const point of points) {
    const start = projectCapabilityGraphPoint(point, input);
    const right = graphDragRotationDelta(point, input, { x: 8, y: 0 });
    const rightEnd = projectCapabilityGraphPoint(point, { ...input, rotationX: input.rotationX + right.rotationX, rotationY: input.rotationY + right.rotationY });
    assert.ok(rightEnd.x > start.x, `right drag must move anchor right for ${JSON.stringify(point)}`);
    const left = graphDragRotationDelta(point, input, { x: -8, y: 0 });
    const leftEnd = projectCapabilityGraphPoint(point, { ...input, rotationX: input.rotationX + left.rotationX, rotationY: input.rotationY + left.rotationY });
    assert.ok(leftEnd.x < start.x, `left drag must move anchor left for ${JSON.stringify(point)}`);
    const down = graphDragRotationDelta(point, input, { x: 0, y: 8 });
    const downEnd = projectCapabilityGraphPoint(point, { ...input, rotationX: input.rotationX + down.rotationX, rotationY: input.rotationY + down.rotationY });
    assert.ok(downEnd.y > start.y, `down drag must move anchor down for ${JSON.stringify(point)}`);
    const up = graphDragRotationDelta(point, input, { x: 0, y: -8 });
    const upEnd = projectCapabilityGraphPoint(point, { ...input, rotationX: input.rotationX + up.rotationX, rotationY: input.rotationY + up.rotationY });
    assert.ok(upEnd.y < start.y, `up drag must move anchor up for ${JSON.stringify(point)}`);
  }
});

test("selected graph node traces prerequisites and unlocks for the student view", () => {
  const nodes = [
    { key: "a", domainKey: "a" }, { key: "b", domainKey: "a" }, { key: "c", domainKey: "a" }, { key: "outside", domainKey: "outside" },
  ];
  const edges = [
    { sourceKey: "a", targetKey: "b", relationship: "prerequisite", strength: "hard", reason: "a before b" },
    { sourceKey: "b", targetKey: "c", relationship: "prerequisite", strength: "hard", reason: "b before c" },
  ];
  const path = traceCapabilityPath(edges, "b");
  assert.deepEqual(path.prerequisites, ["a"]); assert.deepEqual(path.unlocks, ["c"]);
  assert.deepEqual(visibleCapabilityGraph(nodes, edges, "b", "student").nodes.map((node) => node.key), ["a", "b", "c"]);
  assert.equal(visibleCapabilityGraph(nodes, edges, "b", "teacher").nodes.length, 4);
});
