import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadSource } from "./load-source.mjs";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { migratedDatabase, d1 } from "./helpers/migrated-d1.mjs";
import { finalizeHomeworkVerdict, isPendingGradingItem, isSimpleObjectiveAnswer, normalizeHomeworkAnswer, reconcileHomeworkScore, summarizeHomeworkScore, homeworkQuestionLabel, titleWithoutStudent } from "../lib/homework-grading-rules.mjs";
import { rotateNormalizedBox } from "../lib/image-processing-rules.mjs";

test("upright homework keeps nested error locations aligned through every quarter turn without rewriting evidence", () => {
  const box = { x: 100, y: 200, width: 300, height: 400, errors: [{ x: 150, y: 250, width: 80, height: 40, reason: "移项未变号", part: "(2)" }] };
  const before = structuredClone(box);
  for (const [rotation, rect] of [[90, [400, 100, 400, 300]], [180, [600, 400, 300, 400]], [270, [200, 600, 400, 300]]]) {
    const turned = rotateNormalizedBox(box, rotation);
    assert.deepEqual([turned.x, turned.y, turned.width, turned.height], rect);
    assert.equal(turned.errors[0].reason, box.errors[0].reason);
    assert.equal(turned.errors[0].part, "(2)");
    assert.ok(turned.errors[0].x >= turned.x && turned.errors[0].x + turned.errors[0].width <= turned.x + turned.width);
    assert.ok(turned.errors[0].y >= turned.y && turned.errors[0].y + turned.errors[0].height <= turned.y + turned.height);
    assert.deepEqual(rotateNormalizedBox(turned, 360 - rotation), before);
  }
  assert.equal(rotateNormalizedBox(box, 0), box);
  assert.equal(rotateNormalizedBox(box, undefined), box);
  assert.deepEqual(box, before);
});

async function gradingRunFixture(t, phase) {
  const sqlite = await migratedDatabase(); t.after(() => sqlite.close());
  sqlite.exec(`INSERT INTO users(id,email,password_hash,password_salt,password_iterations,role,created_at) VALUES('u','u@test','h','s',1,'admin',0);
    INSERT INTO students(id,owner_user_id,name,class_name,notes,created_at,updated_at) VALUES('student','u','Fixture','','',0,0);
    INSERT INTO homework_assignments(id,owner_user_id,title,status,input_mode,created_at,updated_at) VALUES('assignment','u','Original','closed','completed_homework',0,0);
    INSERT INTO homework_submissions(id,assignment_id,student_id,status,submitted_by_type,submitted_by_id,submitted_at,created_at,updated_at) VALUES('submission','assignment','student','submitted','teacher','u',1,0,0);`);
  const database = d1(sqlite), fixture = { sqlite, database, calls: 0, queued: [], api: null, model: async () => ({ status: 200, text: "{}" }), asset: async () => null };
  const hooks = {
    phase: async () => { fixture.calls++; return phase(fixture); },
    callStructuredAi: input => fixture.model(input),
  };
  const compiled = await build({
    stdin: { contents: `export * from './lib/server/homework-grading'; export * from './lib/server/homework'; export { gradeCompletedQuestions } from './lib/server/completed-homework-grading'; export { callHomeworkModel } from './lib/server/homework-model'; export { AiQueueFailure } from './lib/server/ai/queue-policy';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: "cjs", platform: "node", packages: "external", logLevel: "silent", external: ["fixture:grading"],
    plugins: [{ name: "controlled-grading-phase", setup(plugin) {
      plugin.onResolve({ filter: /^(?:\.\/completed-homework|\.\/ai-gateway)$/ }, args => {
        if (args.path === "./completed-homework" && args.importer.endsWith("/homework-grading.ts")) return { path: "prepare", namespace: "fixture" };
        if (args.path === "./ai-gateway") return { path: "model", namespace: "fixture" };
      });
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "prepare"
        ? 'export { phase as prepareCompletedHomework } from "fixture:grading";'
        : 'export { callStructuredAi } from "fixture:grading";', loader: "js" }));
    } }],
  });
  const require = createRequire(import.meta.url), module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(id => id === "cloudflare:workers" ? { env: { DB: database, HOMEWORK_ASSETS: { get: key => fixture.asset(key) }, HOMEWORK_GRADING_QUEUE: { send: async message => { fixture.queued.push(message); } } } } : id === "fixture:grading" ? hooks : require(id), module, module.exports);
  fixture.api = module.exports;
  fixture.row = () => sqlite.prepare("SELECT * FROM homework_submissions WHERE id='submission'").get();
  fixture.message = (attempts = 1) => ({ body: { kind: "grade_submission", submissionId: "submission" }, attempts, acknowledged: false, retried: null,
    ack() { this.acknowledged = true; }, retry(options) { this.retried = options; } });
  return fixture;
}

test("readable school choices use the recognized option once; uncertain answers and exam scoring keep their existing gates", async t => {
  const f = await gradingRunFixture(t, async () => {});
  f.sqlite.exec(`INSERT INTO homework_assets(id,owner_user_id,r2_key,content_type,byte_size,content_hash,original_name,created_at)
      VALUES('asset','u','fixture','image/jpeg',1,'hash','fixture.jpg',0);
    INSERT INTO submission_pages(id,submission_id,original_asset_id,processed_asset_id,page_order,created_at)
      VALUES('page','submission','asset','asset',0,0);
    INSERT INTO assignment_questions(id,assignment_id,question_number,page_number,type,stem,answer,sort_order,created_at,updated_at)
      VALUES('q','assignment','5',1,'单选题','按规律选择','C',0,0,0);`);
  f.asset = async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer });
  const base = { question_number: "5", page_numbers: [1], type: "单选题", student_answer: "C", answer_state: "readable", question_complete: true,
    teacher_mark: "none", max_score: null, bbox: { x: 708, y: 595, width: 62, height: 50 } };
  for (const scenario of [
    { name: "C matches C even if a second model would read D", modelAnswer: "D", verdict: "correct" },
    { name: "a different recognized choice stays wrong", student: "D", verdict: "incorrect" },
    { name: "full-width and math delimiters", student: "$ｃ$", verdict: "correct" },
    { name: "multiple-choice order", type: "多选题", answer: "AC", student: "Ｃ、Ａ", verdict: "correct" },
    { name: "multiple-choice missing option", type: "多选题", answer: "AC", student: "C", verdict: "incorrect" },
    { name: "school printed marks", max: 2, assigned: false, verdict: "correct", score: 2 },
    { name: "teacher cross wins", mark: "incorrect", verdict: "incorrect" },
    { name: "unreadable recognition is not a confirmed C", state: "unreadable", verdict: "incorrect" },
    { name: "blank recognition is not a confirmed C", state: "blank", verdict: "incorrect" },
    { name: "blocking page quality wins", blocking: true, verdict: "incorrect" },
    { name: "incomplete question cannot be marked", complete: false, error: /题目或参考答案尚未就绪/ },
    { name: "unverified reference cannot be used", verified: false, error: /题目或参考答案尚未就绪/ },
    { name: "ambiguous options still need the model", student: "C或D", modelVerdict: "unreadable", model: true, verdict: "incorrect" },
    { name: "duplicate selections are not silently accepted", type: "多选题", answer: "AC", student: "AAC", model: true, verdict: "incorrect" },
    { name: "fill-in final form still needs the model", type: "填空题", answer: "1", student: "2/2", modelVerdict: "incorrect", model: true, verdict: "incorrect" },
    { name: "international marking keeps model scoring", curriculum: "international", max: 2, model: true, verdict: "correct", score: 2 },
  ]) {
    let calls = 0;
    const evidence = { ...base, type: scenario.type ?? base.type, student_answer: scenario.student ?? "C", answer_state: scenario.state ?? "readable",
      teacher_mark: scenario.mark ?? "none", question_complete: scenario.complete ?? true, max_score: scenario.max ?? null };
    const question = { id: "q", question_number: "5", page_number: 1, type: evidence.type, stem: "按规律选择", answer: scenario.answer ?? "C", analysis: "",
      reference_verified: scenario.verified === false ? 0 : 1, input_evidence_json: JSON.stringify(evidence) };
    f.sqlite.prepare("UPDATE homework_assignments SET curriculum=?,sheet_json=?").run(scenario.curriculum ?? "school", scenario.assigned === false ? "" : "{}");
    f.sqlite.prepare("UPDATE submission_pages SET quality_json=?").run(JSON.stringify({ blocking: scenario.blocking ?? false }));
    f.model = async () => { calls++; return { status: 200, text: JSON.stringify({ results: [{ question_number: "5", page_number: 1,
      student_answer: scenario.modelAnswer ?? evidence.student_answer, verdict: scenario.modelVerdict ?? "correct", confidence: .99, bbox: evidence.bbox }] }) }; };
    if (scenario.error) {
      await assert.rejects(f.api.gradeCompletedQuestions("submission", [question], 1), scenario.error, scenario.name);
      assert.equal(calls, 0, scenario.name); continue;
    }
    await f.api.gradeCompletedQuestions("submission", [question], 1);
    const saved = f.sqlite.prepare("SELECT * FROM grading_items WHERE assignment_question_id='q'").get();
    assert.equal(saved.verdict, scenario.verdict, scenario.name);
    assert.equal(saved.student_answer, evidence.student_answer, scenario.name);
    assert.equal(saved.score, scenario.score ?? null, scenario.name);
    assert.equal(calls, scenario.model ? 1 : 0, scenario.name);
    if (scenario.verdict === "correct") {
      assert.equal(saved.feedback, "", scenario.name);
      assert.equal(saved.requires_review, 0, scenario.name);
      assert.equal(JSON.parse(saved.bbox_json).errors, undefined, scenario.name);
    }
    if (!scenario.model && scenario.verdict === "incorrect" && evidence.answer_state === "readable" && !scenario.blocking && !scenario.mark) {
      assert.match(saved.feedback, /选项/, scenario.name);
      assert.doesNotMatch(saved.feedback, /转录不一致|识别阶段/, scenario.name);
    }
  }
});

test("duplicate grading deliveries cannot enter the recognition phase together and a busy delivery is retried", async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await gradingRunFixture(t, async f => { entered.resolve(); await release.promise; throw new f.api.AiQueueFailure({ code: "UPSTREAM_AUTH_FAILED", status: 401, error: "synthetic terminal failure" }); });
  const first = f.message(), second = f.message();
  const running = f.api.processHomeworkQueue({ messages: [first] });
  await entered.promise;
  try {
    await f.api.processHomeworkQueue({ messages: [second] });
    assert.equal(f.calls, 1);
    assert.equal(second.acknowledged, false); assert.equal(second.retried.delaySeconds, 300);
  } finally { release.resolve(); await running; }
  assert.equal(first.acknowledged, true); assert.equal(f.row().status, "failed"); assert.equal(f.row().grading_run_id, "");
  await f.api.processHomeworkQueue({ messages: [f.message(2)] });
  assert.equal(f.calls, 1, "a terminally failed submission needs an explicit teacher retry");
});

test("a crashed grading worker is not acknowledged away and is reclaimable after its lease", async t => {
  const f = await gradingRunFixture(t, async f => { throw new f.api.AiQueueFailure({ code: "UPSTREAM_AUTH_FAILED", status: 401, error: "synthetic terminal failure" }); });
  f.sqlite.prepare("UPDATE homework_submissions SET status='processing',grading_run_id='crashed',updated_at=?").run(Date.now());
  const early = f.message(2); await f.api.processHomeworkQueue({ messages: [early] });
  assert.equal(f.calls, 0); assert.equal(early.acknowledged, false); assert.equal(early.retried.delaySeconds, 300);
  f.sqlite.prepare("UPDATE homework_submissions SET updated_at=?").run(Date.now() - 6 * 60_000);
  const later = f.message(3); await f.api.processHomeworkQueue({ messages: [later] });
  assert.equal(f.calls, 1); assert.equal(later.acknowledged, true); assert.equal(f.row().grading_run_id, "");
});

test("heartbeats keep a slow active grader from being reclaimed", async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await gradingRunFixture(t, async f => { entered.resolve(); await release.promise; throw new f.api.AiQueueFailure({ code: "UPSTREAM_AUTH_FAILED", status: 401, error: "fixture" }); });
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_800_000_000_000 });
  const running = f.api.processHomeworkQueue({ messages: [f.message()] }); await entered.promise;
  try {
    t.mock.timers.tick(6 * 60_000);
    await Promise.resolve();
    assert.equal(f.row().updated_at, Date.now());
    const duplicate = f.message(2); await f.api.processHomeworkQueue({ messages: [duplicate] });
    assert.equal(f.calls, 1); assert.equal(duplicate.retried.delaySeconds, 300);
  } finally { release.resolve(); await running; }
});

test("two teacher retries enqueue a failed submission only once", async t => {
  const f = await gradingRunFixture(t, async () => {}), user = { id: "u", email: "u@test", role: "admin" };
  f.sqlite.exec("UPDATE homework_submissions SET status='failed'");
  const retried = await Promise.allSettled([f.api.retryHomeworkSubmission("submission", user), f.api.retryHomeworkSubmission("submission", user)]);
  assert.equal(retried.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(retried.find(result => result.status === "rejected").reason.status, 409);
  assert.equal(f.queued.length, 1); assert.equal(f.row().status, "submitted");
});

test("late writes and failure handling from an expired grader cannot change its replacement", async t => {
  const entered = [Promise.withResolvers(), Promise.withResolvers()], release = [Promise.withResolvers(), Promise.withResolvers()];
  const f = await gradingRunFixture(t, async f => {
    const index = f.calls - 1; entered[index].resolve(); await release[index].promise;
    if (index === 0) await f.api.homeworkDb().prepare("UPDATE homework_assignments SET title='stale result' WHERE id='assignment'").run();
    throw new f.api.AiQueueFailure({ code: "UPSTREAM_AUTH_FAILED", status: 401, error: index ? "new run failure" : "old run failure" });
  });
  const old = f.api.processHomeworkQueue({ messages: [f.message()] }); await entered[0].promise;
  f.sqlite.prepare("UPDATE homework_submissions SET updated_at=?").run(Date.now() - 6 * 60_000);
  const replacement = f.api.processHomeworkQueue({ messages: [f.message(2)] }); await entered[1].promise;
  const token = f.row().grading_run_id;
  release[0].resolve(); await old;
  assert.equal(f.sqlite.prepare("SELECT title FROM homework_assignments WHERE id='assignment'").get().title, "Original");
  assert.equal(f.row().grading_run_id, token); assert.equal(f.row().status, "processing"); assert.equal(f.row().failure_reason, "");
  release[1].resolve(); await replacement;
  assert.equal(f.row().failure_reason, "new run failure"); assert.equal(f.row().grading_run_id, "");
});

test("a cancelled grading run cannot write back or fail the teacher's draft", async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await gradingRunFixture(t, async f => {
    entered.resolve(); await release.promise;
    await f.api.homeworkDb().prepare("UPDATE homework_assignments SET title='cancelled result' WHERE id='assignment'").run();
  });
  const running = f.api.processHomeworkQueue({ messages: [f.message()] }); await entered.promise;
  await f.api.updateSubmission("submission", { action: "cancel" }, { id: "u", email: "u@test", role: "admin" });
  release.resolve(); await running;
  assert.equal(f.row().status, "draft"); assert.equal(f.row().grading_run_id, ""); assert.equal(f.row().failure_reason, "");
  assert.equal(f.sqlite.prepare("SELECT title FROM homework_assignments WHERE id='assignment'").get().title, "Original");
});

test("transient queue failures keep checkpoints retryable and release their run token", async t => {
  const f = await gradingRunFixture(t, async f => { throw new f.api.AiQueueFailure({ code: "UPSTREAM_FAILED", status: 503, error: "synthetic upstream failure" }); });
  const first = f.message(); await f.api.processHomeworkQueue({ messages: [first] });
  assert.equal(first.retried.delaySeconds, 30); assert.equal(f.row().status, "processing"); assert.match(f.row().failure_reason, /自动重试/); assert.equal(f.row().grading_run_id, "");
  const last = f.message(4); await f.api.processHomeworkQueue({ messages: [last] });
  assert.equal(f.calls, 2); assert.equal(last.retried, null); assert.equal(last.acknowledged, true); assert.equal(f.row().status, "failed");
});

test("grading write fences are atomic and do not leak into other requests; model calls receive cancellation", async t => {
  const f = await gradingRunFixture(t, async () => {}), controller = new AbortController();
  f.sqlite.exec("UPDATE homework_submissions SET status='processing',grading_run_id='owner'");
  assert.equal(f.api.homeworkDb(), f.database);
  await f.api.withHomeworkGradingRun("submission", "owner", controller.signal, async () => {
    const db = f.api.homeworkDb();
    const changed = await db.prepare("UPDATE homework_assignments SET title=? WHERE id=?").bind("current", "assignment").run();
    assert.equal(changed.meta.changes, 1);
    f.sqlite.exec("UPDATE homework_submissions SET grading_run_id='replacement'");
    await assert.rejects(db.batch([db.prepare("UPDATE homework_assignments SET title='stale' WHERE id='assignment'"), db.prepare("UPDATE homework_submissions SET failure_reason='stale' WHERE id='submission'")]), /malformed JSON/);
    assert.equal(f.row().failure_reason, "");
  });
  assert.equal(f.api.homeworkDb(), f.database);
  assert.equal(f.sqlite.prepare("SELECT title FROM homework_assignments WHERE id='assignment'").get().title, "current");
  f.model = async input => { assert.equal(input.signal, controller.signal); controller.abort(new Error("cancel fixture")); return { status: 200, text: "{}" }; };
  await assert.rejects(f.api.withHomeworkGradingRun("submission", "replacement", controller.signal,
    () => f.api.callHomeworkModel({ prompt: "fixture", images: [], schema: {}, schemaName: "fixture" })), /cancel fixture/);
});

test("school distribution shares whole-question states with the sheet and keeps exam step marks separate", async () => {
  const { resultState, VerdictTally } = await loadSource("app/components/AssignedHomeworkSheet.tsx");
  const correct = { verdict: "correct", requiresReview: false, teacherMark: null, standardAnswer: "5", referenceVerified: true, wasIncorrect: false };
  const partial = { ...correct, verdict: "partial" };
  const corrected = { ...correct, wasIncorrect: true };
  const pending = { ...partial, requiresReview: true, wasIncorrect: true };
  assert.deepEqual([correct, partial, corrected, pending, null].map((item) => resultState(item)), ["correct", "incorrect", "corrected", "pending", "missing"]);
  assert.equal(resultState({ ...partial, wasIncorrect: true }), "incorrect");
  const html = renderToStaticMarkup(createElement(VerdictTally, { items: [correct, partial, corrected, pending, null], total: 5 }));
  for (const [state, label] of [["correct", "正确"], ["incorrect", "错误（待订正）"], ["corrected", "已订正"], ["missing", "未交"]]) assert.ok(html.includes(`<div class="${state}"><dt>${label}</dt><dd>1</dd>`), label);
  assert.equal((html.match(/<dt>/g) ?? []).length, 4);
  assert.doesNotMatch(html, /部分正确|<dt>待处理/);
  assert.match(html, /待核实 1 道/);
  assert.match(html, /未交 1，待核实 1/);
  assert.equal((html.match(/width:20%/g) ?? []).length, 4, "all questions stay in the denominator; pending answers retain neutral space");
  const sheet = renderToStaticMarkup(createElement(VerdictTally, { items: [...Array(6).fill(correct), ...Array(4).fill(partial), null, null], total: 12 }));
  assert.match(sheet, /class="correct" style="width:50%"/);
  assert.match(sheet, /class="incorrect" style="width:33\.33333333333333%"/);
  assert.match(sheet, /class="missing" style="width:16\.666666666666664%"/);
  assert.match(sheet, /<dt>未交<\/dt><dd>2<\/dd>/);
  const unsubmitted = renderToStaticMarkup(createElement(VerdictTally, { items: Array(12).fill(null), total: 12 }));
  assert.match(unsubmitted, /class="missing" style="width:100%"/);
  const grading = renderToStaticMarkup(createElement(VerdictTally, { items: [correct], total: 12 }));
  assert.doesNotMatch(grading, /class="missing"/, "questions awaiting grading are not labelled unsubmitted");
  const exam = renderToStaticMarkup(createElement(VerdictTally, { items: [correct, partial, pending], total: 3, international: true }));
  assert.match(exam, /<dt>部分正确<\/dt><dd>1<\/dd>/);
  assert.equal((exam.match(/<dt>/g) ?? []).length, 4);
});

test("homework exports filter current mistakes while keeping full-sheet analysis available", async () => {
  const { AssignedHomeworkSheet } = await loadSource("app/components/AssignedHomeworkSheet.tsx");
  const settled = { verdict: "incorrect", requiresReview: false, teacherMark: null, standardAnswer: "5", referenceVerified: true, wasIncorrect: false, submissionId: "new-upload" };
  const results = [
    { ...settled, submissionId: "original-upload" }, { ...settled, verdict: "partial" },
    { ...settled, verdict: "correct", wasIncorrect: true }, { ...settled, verdict: "correct" },
    { ...settled, requiresReview: true }, { ...settled, referenceVerified: false }, null,
  ];
  const assigned = {
    days: [{ title: "第 1 天", size: 4, done: 4, correct: 2, firstAttempt: { correct: 1, incorrect: 3, pending: 0 } }, { title: "第 2 天", size: 3, done: 2, correct: 0, firstAttempt: { correct: 0, incorrect: 0, pending: 2 } }],
    questions: results.map((result, index) => ({ id: `q${index}`, number: String(index + 1), question: { stem: "原题", answer: "5", analysis: "移项后求解。" }, result })),
    uploads: [{ id: "original-upload", status: "published", version: 1 }, { id: "new-upload", status: "published", version: 2 }],
  };
  const props = { submission: { id: "original-upload", assigned }, busy: false, onExport: () => {} };
  const html = renderToStaticMarkup(createElement(AssignedHomeworkSheet, props));
  const busy = renderToStaticMarkup(createElement(AssignedHomeworkSheet, { ...props, busy: true }));
  const corrected = { ...assigned, questions: assigned.questions.map((question) => question.result && !question.result.requiresReview ? { ...question, result: { ...question.result, verdict: "correct", wasIncorrect: true } } : question) };
  const completed = renderToStaticMarkup(createElement(AssignedHomeworkSheet, { ...props, submission: { ...props.submission, assigned: corrected } }));
  assert.match(html, /<select class="secondary" aria-label="导出错题" title="导出当前仍需订正的 2 道题，不含答案">/);
  assert.match(busy, /<select class="secondary" aria-label="导出错题" disabled="" title="导出当前仍需订正的 2 道题，不含答案">/);
  assert.match(completed, /<select class="secondary" aria-label="导出错题" disabled="" title="当前没有需要订正的错题">/);
  assert.match(html, /<option value="pdf">PDF<\/option><option value="word">Word<\/option>/);
  assert.match(html, /<select class="secondary" aria-label="导出解析" title="导出整份作业 7 道题的原题、答案与解析">/);
  assert.match(busy, /<select class="secondary" aria-label="导出解析" disabled=""/);
  assert.match(completed, /<select class="secondary" aria-label="导出解析" title="导出整份作业 7 道题的原题、答案与解析">/);
  const withoutAnalysis = { ...assigned, questions: assigned.questions.map((question) => ({ ...question, question: { stem: "只有原题", answer: "", analysis: "" } })) };
  const unavailable = renderToStaticMarkup(createElement(AssignedHomeworkSheet, { ...props, submission: { ...props.submission, assigned: withoutAnalysis } }));
  assert.match(unavailable, /<select class="secondary" aria-label="导出解析" disabled="" title="当前作业暂无答案或解析">/);
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

for (const [name, type, standardAnswer, studentAnswer, verdict] of [
  ["judgement synonyms", "判断题", "对", "正确", "correct"],
  ["multiple-choice order", "多选题", "AB", "BA", "correct"],
  ["two blanks are not one integer", "填空题", "1,2", "12", "incorrect"],
  ["positive integer sign", "填空题", "2", "+2", "correct"],
]) test(`MP-02 ${name}`, () => {
  assert.equal(finalizeHomeworkVerdict({ type, standardAnswer, studentAnswer, modelVerdict: verdict, confidence: .99 }).verdict, verdict);
});

test("objective comparisons preserve choice validity, blank order and explicit answer format", () => {
  const grade = (type, standardAnswer, studentAnswer, modelVerdict = "correct", stem = "") => finalizeHomeworkVerdict({ type, standardAnswer, studentAnswer, modelVerdict, stem, confidence: .99 }).verdict;
  assert.equal(grade("判断题", "正确", "FALSE"), "incorrect");
  assert.equal(grade("多选题", "A,C", "Ｃ、Ａ"), "correct");
  assert.equal(grade("多选题", "AC", "AB"), "incorrect");
  assert.equal(grade("多选题", "AC", "AAC"), "incorrect");
  assert.equal(grade("单选题", "A", "AA"), "incorrect");
  assert.equal(grade("填空题", "1,2", "2,1"), "incorrect");
  assert.equal(grade("填空题", "1,2", "1;2"), "correct");
  assert.equal(grade("填空题", "12", "1,2"), "incorrect");
  assert.equal(grade("填空题", "2", "2/1", "correct"), "correct", "ambiguous final forms retain mathematical judgement");
  assert.equal(grade("填空题", "2", "2/1", "incorrect"), "incorrect");
  assert.equal(grade("填空题", "2", "+2", "incorrect", "答案不得带正号"), "incorrect");
  assert.equal(grade("填空题", "2", "2", "incorrect", "保留两位小数"), "incorrect");
});

test("normalizes objective homework answers conservatively", () => {
  assert.equal(normalizeHomeworkAnswer("答案：Ａ，C。"), "AC");
  assert.equal(normalizeHomeworkAnswer("✓"), "正确");
  assert.equal(isSimpleObjectiveAnswer("填空题", "-2.5"), false, "a decimal reference needs value and final-form checks");
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

test("decimal references retain the model's reduced-fraction and final-form judgement", () => {
  const grade = (standardAnswer, studentAnswer, modelVerdict) => finalizeHomeworkVerdict({
    type: "填空题", standardAnswer, studentAnswer, modelVerdict, confidence: .95,
  });
  for (const [reference, answer] of [["0.8", "$\\frac{4}{5}$"], ["0.5", "1/2"], ["-2.5", "-5/2"]]) {
    assert.equal(grade(reference, answer, "correct").verdict, "correct", "a reduced fraction can match a decimal reference");
  }
  for (const [reference, answer] of [["0.8", "2/2.5"], ["0.5", "2/4"], ["0.8", "0.8"], ["2/4", "2/4"]]) {
    assert.equal(grade(reference, answer, "incorrect").verdict, "incorrect", "equal values or strings cannot override an unfinished final answer");
  }
  assert.equal(grade("0.8", "0.8", "correct").verdict, "correct", "an explicit decimal/precision requirement is still judged by the model");
  assert.equal(grade("5", "5", "incorrect").verdict, "correct", "plain integer comparisons remain deterministic");
  const methodMarks = finalizeHomeworkVerdict({ type: "解答题", standardAnswer: "0.8", studentAnswer: "2/2.5",
    modelVerdict: "partial", modelScore: 2, maxScore: 3, confidence: .95, curriculum: "international" });
  assert.deepEqual([methodMarks.verdict, methodMarks.score], ["partial", 2], "an unfinished final fraction does not erase earned method marks");
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
