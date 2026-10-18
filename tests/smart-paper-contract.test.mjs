import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { loadSource } from "./load-source.mjs";
import { sqliteD1 } from "./helpers/ai-v2-sqlite.mjs";

// 智能组卷 rules that need no model: how a question's calculation is read, how a focus maps onto it, and how the model's
// answer is checked and completed.
const contract = await loadSource("lib/smart-paper-contract.ts");
const { questionFeatures, focusFeatures, assembleSmartPaperPlan, normalizeSmartPaperBriefResult, normalizeSmartPaperPlan, buildSmartPaperBriefPrompt, buildSmartPaperSelectPrompt } = contract;

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
  const evidence = "《计算复习》第3题（第1次上传）：将括号外的负号也参与平方，错误算成正数。";
  const { brief, findings } = normalizeSmartPaperBriefResult({
    title: "刘羽汐 · 计算打卡", days: 5, per_day: 10, category_ids: ["calc-rational-mixed", "invented"], question_types: ["解答题", "作文"],
    difficulty: "由易到难", focus: [{ label: "去括号", description: "括号前是负号" }], findings: [{ label: "负号与乘方", evidence }],
  }, new Set(["calc-rational-mixed"]), `- ${evidence}｜原题：计算`);
  assert.deepEqual(brief.categoryIds, ["calc-rational-mixed"]);
  assert.deepEqual(brief.questionTypes, ["解答题"]);
  assert.equal(brief.perDay, 10);
  assert.equal(findings[0].evidence, evidence);
});

test("historical causes require a verbatim source and concrete feedback, not invented or stitched evidence", () => {
  const first = "《复习》第14题（第1次上传）：化简已正确，但未利用整体关系继续求值。";
  const second = "《复习》第31题（第1次上传）：将负号在括号外的平方误算成正数。";
  const digest = `- ${first}｜原题：整式求值\n- ${second}｜原题：乘方\n- 未作答记录（待确认）：《复习》第6题（第1次上传）：未作答，缺少过程。`;
  const sources = [first, second, first.replace("14题", "99题"), first.replace("化简已正确", "不会化简"), first + second, "《复习》第31题（第1次上传）：", "《复习》第6题（第1次上传）：未作答，缺少过程。"];
  const raw = { findings: sources.map((evidence, index) => ({ label: `原因${index}`, evidence })) };
  const { findings } = normalizeSmartPaperBriefResult(raw, new Set(), digest);
  assert.deepEqual(findings.map((item) => item.evidence), [first, second]);
  assert.deepEqual(normalizeSmartPaperBriefResult(raw, new Set(), "").findings, []);
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
  assert.equal(plan.groups[1].items[0].reason, "一般巩固（系统补选：式子含括号前负号），未核对具体历史错因", "filled with the focus first without inventing a historical link");
  assert.equal(plan.groups[1].items[2].reason, "一般巩固（系统补选），未核对具体历史错因");
  assert.deepEqual(normalizeSmartPaperPlan(plan), plan, "an assembled plan is a valid stored plan");
});

test("a selected question keeps the verified historical cause through balancing and draft normalization", () => {
  const evidence = "《整式复习》第31题（第1次上传）：把 $-(1)^2$ 错误计算为 $1$。";
  const focus = "负号与乘方";
  const reason = "比较括号内外的负号，先算乘方。".repeat(18);
  const findings = [{ label: focus, evidence }];
  const plan = assembleSmartPaperPlan({ request: "两天持平", studentId: "s1", brief: { ...brief, perDay: 1, difficulty: "各天持平" }, findings, avoided: 0,
    candidates, selection: { days: [{ items: [{ code: "0001", focus, reason }] }, { items: [{ code: "0002", focus: "通分", reason: "分数运算" }] }] } });
  const linked = plan.groups.flatMap((day) => day.items).find((item) => item.id === "id-1");
  assert.equal(linked.reason, `针对历史错因：${evidence}；本题训练：${reason}`);
  assert.ok(linked.reason.length > 300, "source and full training explanation must survive saved-plan normalization");
  const general = plan.groups.flatMap((day) => day.items).find((item) => item.id === "id-2");
  assert.equal(general.reason, "一般巩固：分数运算");
  assert.deepEqual(normalizeSmartPaperPlan(plan), plan);
});

test("the select prompt lists candidates by code and carries the previous plan when revising", () => {
  const prompt = buildSmartPaperSelectPrompt({ request: "各天难度平均，不要递进", brief, candidates: candidates.slice(0, 2), current: [{ theme: "热身", codes: ["0001"] }], instruction: "第 2 天难一点" });
  assert.match(prompt, /0001｜基础｜繁度1｜括号前负号｜\$1\$/);
  assert.match(prompt, /第 1 天（热身）：0001/);
  assert.match(prompt, /第 2 天难一点/);
  assert.match(prompt, /老师的原始要求：各天难度平均，不要递进/);
  assert.match(prompt, /未限定难度安排/);
  assert.doesNotMatch(prompt, /后几天的繁度整体高于前几天|最后一天以繁度 3—5/);
});

test("revisions retain the previous difficulty request unless the latest instruction changes it", () => {
  const prompt = buildSmartPaperBriefPrompt({ request: "出 3 天练习", current: { ...brief, difficulty: "各天持平，不递进" }, instruction: "标题改为计算练习", digest: "", outline: [] });
  assert.match(prompt, /各天持平，不递进/);
  assert.match(prompt, /标题改为计算练习/);
  assert.match(prompt, /其余沿用上一版要求/);
});

test("balanced days correct a model's progression and preserve every selected question and reason", () => {
  const pool = Array.from({ length: 15 }, (_, index) => ({ ...candidate(index + 1, "基础", []), level: Math.floor(index / 3) + 1 }));
  const selection = { days: Array.from({ length: 3 }, (_, day) => ({ theme: ["热身", "进阶", "挑战"][day], items: pool.slice(day * 5, day * 5 + 5).map((question) => ({ code: question.code, focus: "计算", reason: `依据 ${question.code}` })) })) };
  for (const difficulty of ["难度平均，各天难度持平且不用递进", "各天难度相当，不逐日加深", "各天难度相近", "各天持平，每天内部由易到难"]) {
    const plan = assembleSmartPaperPlan({ request: "平均", studentId: null, brief: { ...brief, days: 3, perDay: 5, difficulty }, findings: [], avoided: 0, selection, candidates: pool });
    const byId = new Map(pool.map((question) => [question.id, question]));
    assert.deepEqual(plan.groups.map((day) => day.items.map((item) => byId.get(item.id).level).sort()), [[1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5]], difficulty);
    assert.equal(new Set(plan.groups.flatMap((day) => day.items.map((item) => item.id))).size, 15);
    assert.ok(plan.groups.flatMap((day) => day.items).every((item) => item.reason === `依据 ${byId.get(item.id).code}`));
    assert.ok(plan.groups.every((day) => day.theme.startsWith("均衡练习")));
  }
});

test("balanced filling distributes all available bands, including when candidates are insufficient", () => {
  const pool = Array.from({ length: 9 }, (_, index) => candidate(index + 1, ["基础", "中等", "提高"][Math.floor(index / 3)], ["分数"]));
  for (const available of [pool, pool.slice(0, 8)]) {
    const plan = assembleSmartPaperPlan({ request: "平均", studentId: null, brief: { ...brief, days: 3, perDay: 3, difficulty: "各天难度平均" }, findings: [], avoided: 0, selection: {}, candidates: available });
    const byId = new Map(available.map((question) => [question.id, question]));
    assert.equal(new Set(plan.groups.flatMap((day) => day.items.map((item) => item.id))).size, available.length);
    assert.ok(plan.groups.every((day) => day.items.length >= 2 && day.items.length <= 3));
    for (const label of ["基础", "中等", "提高"]) {
      const counts = plan.groups.map((day) => day.items.filter((item) => byId.get(item.id).difficulty === label).length);
      assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
    }
    assert.ok(plan.groups.flatMap((day) => day.items).every((item) => item.reason.startsWith("系统补选")));
  }
});

test("equal means alone do not hide different difficulty distributions", () => {
  const levels = [1, 1, 5, 5, 3, 3, 3, 3];
  const pool = levels.map((level, index) => ({ ...candidate(index + 1, "基础", []), level }));
  const selection = { days: [0, 1].map((day) => ({ theme: "计算", items: pool.slice(day * 4, day * 4 + 4).map((item) => ({ code: item.code })) })) };
  const plan = assembleSmartPaperPlan({ request: "平均", studentId: null, brief: { ...brief, perDay: 4, difficulty: "难度平均" }, findings: [], avoided: 0, selection, candidates: pool });
  const byId = new Map(pool.map((item) => [item.id, item]));
  assert.deepEqual(plan.groups.map((day) => day.items.map((item) => byId.get(item.id).level).sort()), [[1, 3, 3, 5], [1, 3, 3, 5]]);
});

test("already balanced days keep their original order and themes", () => {
  const pool = [candidate(1, "中等", []), candidate(2, "基础", []), candidate(3, "基础", []), candidate(4, "中等", [])];
  const selection = { days: [{ theme: "复习 A", items: [{ code: "0001" }, { code: "0002" }] }, { theme: "复习 B", items: [{ code: "0003" }, { code: "0004" }] }] };
  const plan = assembleSmartPaperPlan({ request: "平均", studentId: null, brief: { ...brief, perDay: 2, difficulty: "各天难度一致" }, findings: [], avoided: 0, selection, candidates: pool });
  assert.deepEqual(plan.groups.map((day) => ({ theme: day.theme, ids: day.items.map((item) => item.id) })), [{ theme: "复习 A", ids: ["id-1", "id-2"] }, { theme: "复习 B", ids: ["id-3", "id-4"] }]);
});

test("redistribution keeps the working load close without concentrating one focus on a single day", () => {
  const levels = [3, 3, 3, 3, 3, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4];
  const focuses = ["去括号", "去括号", "去括号", "去括号", "去括号", "去括号", "分配律", "分配律", "通分", "分配律", "分配律", "通分", "通分", "分配律", "分配律"];
  const pool = levels.map((level, index) => ({ ...candidate(index + 1, "基础", []), level }));
  const selection = { days: [0, 1, 2].map((day) => ({ theme: "计算", items: pool.slice(day * 5, day * 5 + 5).map((item, index) => ({ code: item.code, focus: focuses[day * 5 + index] })) })) };
  const plan = assembleSmartPaperPlan({ request: "平均", studentId: null, brief: { ...brief, days: 3, perDay: 5, difficulty: "难度平均" }, findings: [], avoided: 0, selection, candidates: pool });
  const byId = new Map(pool.map((item) => [item.id, item]));
  assert.deepEqual(plan.groups.map((day) => day.items.reduce((sum, item) => sum + byId.get(item.id).level, 0)), [15, 15, 15]);
  assert.ok(plan.groups.every((day) => new Set(day.items.map((item) => item.focus)).size >= 2));
});

test("progressive, unspecified and explicitly unequal requests are not flattened", () => {
  const selection = { days: [{ theme: "基础", items: [{ code: "0001" }, { code: "0003" }] }, { theme: "提高", items: [{ code: "0002" }, { code: "0004" }] }] };
  for (const difficulty of ["", "未限定难度安排", "逐日递进", "不要求难度平均，各天递进", "不需要各天持平", "各天均匀递增"]) {
    const plan = assembleSmartPaperPlan({ request: "练习", studentId: null, brief: { ...brief, perDay: 2, difficulty }, findings: [], avoided: 0, selection, candidates });
    assert.deepEqual(plan.groups.map((day) => day.items.map((item) => item.id)), [["id-1", "id-3"], ["id-2", "id-4"]], difficulty);
    assert.deepEqual(plan.groups.map((day) => day.theme), ["基础", "提高"]);
  }
});

test("generation sends published inline error causes to both model calls and attaches only verified sources", async () => {
  const db = sqliteD1({ v2: false });
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  try {
    for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
      if (!/^001[45]_/.test(file)) db.sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
    }
    db.sqlite.exec(`
      INSERT INTO users(id,email,password_hash,password_salt,password_iterations,role,created_at) VALUES('teacher','teacher@example.invalid','test','test',1,'admin',1);
      INSERT INTO students(id,owner_user_id,name,created_at,updated_at) VALUES('student','teacher','示例同学',1,1);
      UPDATE libraries_v2 SET active_publication_id=NULL WHERE id='public';
      INSERT INTO library_modules_v2(row_id,source_id,library_id,name,created_at,updated_at) VALUES('m','calc','public','计算',1,1);
      INSERT INTO scoped_library_meta(key,value) VALUES('asset_access_v1','done');
      INSERT INTO homework_assignments(id,owner_user_id,title,created_at,updated_at) VALUES('homework','teacher','整式复习',1,1);
    `);
    for (let i = 1; i <= 3; i++) {
      const question = { stem: i === 2 ? "$3+4$" : `$-${i}^2+(-3)^2$`, type: "解答题", difficulty: "基础", tags: [] };
      db.sqlite.prepare(`INSERT INTO library_questions_v2(row_id,source_id,library_id,module_source_id,payload_json,created_at,updated_at) VALUES(?,?,'public','calc',?,1,1)`)
        .run(`row-${i}`, `new-${i}`, JSON.stringify(question));
    }
    const cause = "将 $-(1)^2$ 错误计算为 $1$，应先算乘方再保留外面的负号。";
    const evidence = `《整式复习》第31题（第1次上传）：${cause}`;
    const focus = "负号与乘方";
    for (const [index, status, review, feedback, bbox] of [
      [1, "published", 0, "", JSON.stringify({ errors: [{ reason: cause }] })],
      [2, "ready", 0, "未发布的错误不能参与选题", "{}"],
      [3, "published", 1, "尚待复核的错误不能参与选题", "{}"],
      [4, "published", 0, "未作答，缺少所需过程。", "invalid legacy box"],
    ]) {
      db.sqlite.prepare(`INSERT INTO assignment_questions(id,assignment_id,question_number,page_number,type,stem,sort_order,created_at,updated_at) VALUES(?,'homework',?,1,'解答题','计算',?,1,1)`)
        .run(`old-${index}`, String(index === 1 ? 31 : index), index);
      db.sqlite.prepare(`INSERT INTO homework_submissions(id,assignment_id,student_id,version,status,submitted_by_type,submitted_by_id,created_at,updated_at) VALUES(?,'homework','student',?,?,'teacher','teacher',1,1)`)
        .run(`upload-${index}`, index, status);
      db.sqlite.prepare(`INSERT INTO grading_items(id,submission_id,assignment_question_id,verdict,feedback,bbox_json,requires_review,created_at,updated_at) VALUES(?,?,?,'incorrect',?,?,?,1,1)`)
        .run(`grade-${index}`, `upload-${index}`, `old-${index}`, feedback, bbox, review);
    }
    Object.assign(process.env, { OPENAI_API_KEY: "synthetic-test-key", OPENAI_BASE_URL: "https://smart-paper.test.invalid", OPENAI_API_MODE: "responses", OPENAI_TEXT_MODEL: "synthetic-model" });
    const prompts = [];
    globalThis.fetch = async (url, init) => {
      assert.ok(String(url).startsWith("https://smart-paper.test.invalid/"), "never call a real provider in this test");
      const body = JSON.parse(init.body);
      prompts.push(body.input[0].content[0].text);
      const result = prompts.length === 1
        ? { title: "针对训练", days: 1, per_day: 3, category_ids: ["calc"], question_types: [], difficulty: "基础",
          focus: [{ label: focus, description: "比较负号与乘方" }], findings: [{ label: focus, evidence }, { label: "编造错因", evidence: evidence.replace("31题", "99题") }] }
        : { days: [{ theme: "针对训练", items: [{ code: "0001", focus, reason: "本题含括号外的负号，需要先算平方再取相反数。" }, { code: "0002", focus: "普通计算", reason: "整数加法。" }] }] };
      return Response.json({ output_text: JSON.stringify(result) });
    };
    const { generateSmartPaper } = await loadSource("lib/server/smart-paper.ts", { DB: db });
    const { plan } = await generateSmartPaper({ id: "teacher", role: "admin", email: "teacher@example.invalid" }, { studentId: "student", request: "3道计算题" });
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      assert.ok(prompt.includes(cause), "the inline reason survives even when feedback is empty");
      assert.ok(prompt.includes("《整式复习》第31题（第1次上传）"));
      assert.doesNotMatch(prompt, /未发布的错误不能参与选题|尚待复核的错误不能参与选题/);
    }
    assert.deepEqual(plan.findings, [{ label: focus, evidence }], "fabricated question references are discarded");
    assert.ok(plan.groups[0].items[0].reason.includes(evidence));
    assert.match(plan.groups[0].items[0].reason, /先算平方再取相反数/);
    assert.equal(plan.groups[0].items[1].reason, "一般巩固：整数加法。");
    assert.match(plan.groups[0].items[2].reason, /^一般巩固（系统补选/);
    assert.deepEqual(normalizeSmartPaperPlan(plan), plan);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    db.sqlite.close();
  }
});
