import { localD1Rows as d1Rows } from './helpers/local-d1-observer.mjs';
import { loadSource } from "./load-source.mjs";
import { loopbackFetch as fetch } from './helpers/loopback-fetch.mjs';
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const CONFIG = join(ROOT, "dist", "server", "wrangler.json");
const INVITE = "homework-e2e-invite";

function command(args) {
  const result = spawnSync(WRANGLER, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}


async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port)); });
  });
}

function startWorker(port, persistTo, vars) {
  const args = [join(ROOT, "scripts/start-local-test-worker.mjs"), CONFIG, String(port), persistTo, JSON.stringify(vars)];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForServer(url, worker) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (worker.child.exitCode != null) throw new Error(`Worker 提前退出\n${worker.output()}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch { /* 等待监听端口 */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  throw new Error(`Worker 启动超时\n${worker.output()}`);
}

async function stopWorker(worker) {
  if (worker.child.exitCode != null) return; worker.child.kill("SIGINT");
  await Promise.race([new Promise((resolveExit) => worker.child.once("exit", resolveExit)), new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
  if (worker.child.exitCode == null) worker.child.kill("SIGKILL");
}

async function jsonRequest(base, path, { cookie = "", method = "GET", body, headers = {} } = {}) {
  const requestHeaders = { ...headers }; if (cookie) requestHeaders.Cookie = cookie;
  if (body !== undefined) { requestHeaders["Content-Type"] = "application/json"; requestHeaders.Origin = base; }
  const response = await fetch(`${base}${path}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => ({})); return { response, payload };
}

async function upload(base, path, cookie, bytes, name = "作业页面.jpg") {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: {
    Cookie: cookie, Origin: base, Connection: "close", "Content-Type": "image/jpeg", "X-File-Name": encodeURIComponent(name),
  }, body: bytes, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => ({})); return { response, payload };
}

function sessionCookie(response) { return (response.headers.get("set-cookie") ?? "").split(";", 1)[0]; }

function testJpeg() {
  const width = 800; const height = 1100; const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 90; y < height - 80; y += 80) for (let x = 70; x < width - 70; x += 1) {
    const offset = (y * width + x) * 4; data[offset] = 60; data[offset + 1] = 70; data[offset + 2] = 75;
  }
  const ink = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const offset = (y * width + x) * 4; data[offset] = data[offset + 1] = data[offset + 2] = 25; } };
  ink(520, 292, 680, 295); ink(598, 262, 601, 322); // a printed figure: axes between the ruled lines
  return jpeg.encode({ data, width, height }, 82).data;
}

function startMockModel(port) {
  const state = { failAll: false, failureCalls: 0, gradingCalls: 0, supplementalReadable:false,multiPage:false,invalidPage:0,pageExtractionCalls:{},locatorCalls:0,teacherMarked:"",referenceNumbers:[],gradedNumbers:[],verdictOnlyPrompts:0 };
  const server = createHttpServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const prompt = String(payload.input?.[0]?.content?.find((item) => item.type === "input_text")?.text ?? "");
    if (state.failAll && prompt.includes("只识别学生已完成的数学作业")) {
      state.failureCalls += 1; response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: "mock grading unavailable" } })); return;
    }
    if (prompt.includes("只识别学生已完成的数学作业") && prompt.includes("IGCSE / A Level 英文试卷")) {
      const questions=[
        {question_number:"1(a)",page_numbers:[1],type:"解答题",stem:"Solve $x+1=3$.",options:[],student_answer:"x=2",answer_state:"readable",question_complete:true,max_score:2},
        {question_number:"1(b)",page_numbers:[1],type:"解答题",stem:"Hence find $x^2$.",options:[],student_answer:"x^2=2",answer_state:"readable",question_complete:true,max_score:3},
        {question_number:"2",page_numbers:[1],type:"解答题",stem:"Sketch $y=x^2$.",options:[],student_answer:"",answer_state:"unreadable",question_complete:true,max_score:4},
      ].map(q=>({...q,bbox:{x:90,y:100,width:700,height:100},knowledge_tags:[],capability_keys:[],figures:[],figure_notes:"",teacher_mark:"none"}));
      response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({output_text:JSON.stringify({questions,page:{page_number:1,kind:"questions",question_numbers:questions.map(q=>q.question_number),reason:""}})}));return;
    }
    if (prompt.includes("只识别学生已完成的数学作业")) {
      const primary=Number(prompt.match(/本次仅处理 PDF 第 (\d+) 页/)?.[1]??1);
      state.pageExtractionCalls[primary]=(state.pageExtractionCalls[primary]??0)+1;
      // A worksheet the teacher already marked: question 3 has two sub-questions, the printed (1) still without its page prefix.
      const marked=[
        {question_number:"3(1)",page_numbers:[1],type:"填空题",stem:"3. 计算：(1) 1+1",options:[],student_answer:"2",answer_state:"readable",question_complete:true,teacher_mark:"correct"},
        {question_number:"1-3(2)",page_numbers:[1],type:"填空题",stem:"3. 计算：(2) 2+2",options:[],student_answer:"5",answer_state:"readable",question_complete:true,teacher_mark:"incorrect"},
        ...(state.teacherMarked==="split"?[
          {question_number:"1-4(1)",page_numbers:[1],type:"填空题",stem:"4. 计算：(1) 4+4",options:[],student_answer:"9",answer_state:"readable",question_complete:true,teacher_mark:"none"},
          {question_number:"1-4(2)",page_numbers:[1],type:"填空题",stem:"4. 计算：(2) 5+5",options:[],student_answer:"10",answer_state:"readable",question_complete:true,teacher_mark:"correct"},
        ]:[{question_number:"1-4",page_numbers:[1],type:"填空题",stem:"4. 计算 4+4",options:[],student_answer:"9",answer_state:"readable",question_complete:true,teacher_mark:"none"}]),
      ];
      const questions=(state.teacherMarked?marked:state.multiPage?[{question_number:`${primary}-1`,page_numbers:[primary],type:"填空题",stem:"计算 2+3",options:[],student_answer:"6",answer_state:"readable",question_complete:true}]:[
        {question_number:"D1",page_numbers:[1],type:"填空题",stem:"计算 2+3",options:[],student_answer:"6",answer_state:"readable",question_complete:true},
        {question_number:"D2",page_numbers:[1],type:"解答题",stem:"求解 x+1=3 并验算",options:[],student_answer:"移项到x=2",answer_state:"readable",question_complete:true},
        {question_number:"D3",page_numbers:[1],type:"填空题",stem:"计算 3+3",options:[],student_answer:"",answer_state:"blank",question_complete:true},
        {question_number:"D4",page_numbers:[1],type:"填空题",stem:"计算 4+4",options:[],student_answer:state.supplementalReadable?"8":"",answer_state:state.supplementalReadable?"readable":"unreadable",question_complete:true},
        {question_number:"D5",page_numbers:[1],type:"解答题",stem:"条件不完整",options:[],student_answer:"10",answer_state:"readable",question_complete:false},
      ]).map(q=>({teacher_mark:"none",...q,max_score:({D1:2,D2:4,D3:1,D4:1,D5:3}[q.question_number]??null),bbox:{x:90,y:100,width:700,height:100},knowledge_tags:["有理数运算"],capability_keys:["skill:calculation"],
        figures:q.question_number==="D1"?[{kind:"stem",bbox:{x:660,y:240,width:180,height:50}}]:[],figure_notes:q.question_number==="D1"?"坐标轴":""}));
      response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({output_text:JSON.stringify({questions,page:{page_number:state.invalidPage===primary?1:primary,kind:"questions",question_numbers:questions.map(q=>q.question_number),reason:""}})}));return;
    }
    if(prompt.includes("作业配图定位助手")) {state.locatorCalls+=1;response.writeHead(500,{"Content-Type":"application/json"});response.end(JSON.stringify({error:{message:"homework read with figures needs no locator"}}));return;}
    if(prompt.includes("建立独立参考解答")) {
      assert.doesNotMatch(prompt,/student_answer/);
      const numbers=[...new Set([...prompt.matchAll(/"question_number":"([^"]+)"/g)].map(m=>m[1]))];state.referenceNumbers.push(...numbers);
      const answers=numbers.map(n=>({question_number:n,answer:({D1:"5",D2:"x=2",D3:"6",D4:"8"}[n]??"5"),analysis:"独立验算推导",source:prompt.includes("提供的 0 张")?"agent":"provided"}));
      response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({output_text:JSON.stringify({answers})}));return;
    }
    if(prompt.includes("独立核验参考答案")) {
      assert.doesNotMatch(prompt,/student_answer/);
      const numbers=[...new Set([...prompt.matchAll(/"question_number":"([^"]+)"/g)].map(m=>m[1]))];
      const results=numbers.map(n=>({question_number:n,verified:true,reason:"已独立验算成立"}));
      response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({output_text:JSON.stringify({results})}));return;
    }
    if (prompt.includes("IGCSE / A Level 数学学习诊断助手")) {
      assert.match(prompt, /"question_number":"2","stem":"Sketch \$y=x\^2\$\.","score":0,"max_score":4,"verdict":"unreadable"/);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ output_text: JSON.stringify({ overview: "第 1(a) 题完成稳定，优先补全第 1(b) 题。", priorities: ["平方计算"], topics: [{ question: "1", topic: "一次方程", note: "第(b)问计算有误。" }],
        losses: [{ section: "代数", question_numbers: ["1(b)"], title: "平方算错", fact: "写成 $x^2=2$。", knowledge: "知识方法已体现。", method: "$$x^2=4$$", action: "重新计算并代回检验。" }],
        practice: [{ focus: "计算", action: "重做第 1(b) 题。", standard: "一次算对并代回检验。" }], checklist: "每题结束前检查是否答全。" }) }));
      return;
    }
    if (prompt.includes("学习诊断助手")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ output_text: JSON.stringify({
        overall_summary: "本次作业已完成，计算与步骤表达仍需巩固。", student_message: "先重做错题，再逐步核对结论。",
        strengths: [], gaps: [{ title: "步骤需要完整", detail: "部分题目只完成了部分推导。", question_numbers: ["D2"], capability_key: "skill:expression" }],
        actions: ["重做错题并写出错误原因。"], warnings: [],
      }) }));
      return;
    }
    state.gradingCalls += 1;
    const numbers = [...prompt.matchAll(/题号 ([^\n]+)/g)].map((match) => match[1].trim());
    state.gradedNumbers.push(...numbers); if (prompt.includes("本作业只判对错")) state.verdictOnlyPrompts += 1;
    if (prompt.includes("本作业为 IGCSE / A Level")) {
      assert.match(prompt, /题号 1\(b\)\n题型：解答题\n满分：3/); assert.match(prompt, /结果分（A）只在对应方法分已得时才给/);
      const results = numbers.map((number) => ({ question_number: number, page_number: 1, student_answer: number === "1(a)" ? "x=2" : "x^2=2", verdict: number === "1(a)" ? "correct" : "partial", score: number === "1(a)" ? 2 : 1,
        feedback: number === "1(a)" ? "" : "方法分已得，结果算错。", error_type: number === "1(a)" ? "" : "计算", step_analysis: number === "1(a)" ? ["M1 ✓", "A1 ✓"] : ["M1 ✓", "A1 ✗", "A1 ✗"], evidence_summary: "", capability_keys: [], confidence: .9, bbox: null, warnings: [] }));
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ output_text: JSON.stringify({ results }) })); return;
    }
    if (numbers.includes("D2")) assert.match(prompt, /题号 D2\n题型：解答题\n满分：4/);
    const results = numbers.map((number, index) => ({
      question_number: number, page_number: 1, student_answer: /^1-4(?:\(1\))?$/.test(number) ? "9" : /^(?:[1-5])-1$/.test(number) ? "6" : number === "D1" ? "6" : number === "D4" ? "8" : number === "D2" ? "移项到x=2" : "B",
      verdict: number === "D2" ? "partial" : "incorrect", score: number === "D2" ? 2.5 : 0, feedback: number === "D2" ? "推导未完成" : "结果与参考答案不同",
      error_type: number === "D2" ? "步骤" : "计算", confidence: .98,
      step_analysis: number === "D2" ? ["正确写出了部分移项过程", "缺少最终验算"] : [], evidence_summary: "学生作答与参考答案不同",
      capability_keys: ["skill:calculation"], bbox: { x: 90, y: 120 + index * 280, width: 760, height: 190 }, warnings: [],
    }));
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ output_text: JSON.stringify({ results }) }));
  });
  return new Promise((resolveStart, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolveStart({ server, state })); });
}

async function waitForSubmission(base, cookie, id, expected, worker, timeout = 30_000) {
  const deadline = Date.now() + timeout; let latest;
  while (Date.now() < deadline) {
    latest = await jsonRequest(base, `/api/submissions/${id}`, { cookie });
    if (expected.includes(latest.payload.submission?.status)) return latest.payload.submission;
    if (worker.child.exitCode != null) throw new Error(`Worker 提前退出\n${worker.output()}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  }
  throw new Error(`等待提交状态 ${expected.join("/")} 超时，最后状态 ${latest?.payload?.submission?.status}\n${worker.output()}`);
}

async function uploadPage(base, cookie, submissionId, bytes) {
  const page = await upload(base, `/api/homework-assets?submissionId=${submissionId}&role=submission_original`, cookie, bytes);
  assert.equal(page.response.status, 201); return { assetId: page.payload.asset.id };
}

async function submitPages(base, cookie, submissionId, pages) {
  assert.equal((await jsonRequest(base, `/api/submissions/${submissionId}`, { cookie, method: "PUT", body: { action: "save-pages", pages } })).response.status, 200);
  assert.equal((await jsonRequest(base, `/api/submissions/${submissionId}`, { cookie, method: "PUT", body: { action: "submit" } })).response.status, 200);
}

test("completed homework is graded, archives only incorrect work, preserves pending items and correction history, isolates accounts, and retries failures", { timeout: 180_000 }, async () => {
  const [port, modelPort] = await Promise.all([freePort(), freePort()]); const stateDir = await mkdtemp(join(tmpdir(), "zhiti-homework-e2e-"));
  command(["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir, "--config", join(ROOT, "wrangler.jsonc")]);
  const mock = await startMockModel(modelPort); const worker = startWorker(port, stateDir, {
    LOCAL_ADMIN_MODE: "false", AI_PROVIDER_LOCAL_HTTP: "true", AI_PROVIDER_ENCRYPTION_KEY: "synthetic-homework-v2-secret", HOMEWORK_GRADING_ENABLED: "true", REGISTRATION_INVITE_CODE: INVITE, ADMIN_EMAIL: "admin@homework.test",
    OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, OPENAI_API_MODE: "responses",
    HOMEWORK_GRADING_MODEL: "mock-homework", OPENAI_VISION_MODEL: "mock-scanner", HOMEWORK_QUEUE_RETRY_BASE_SECONDS: "1", HOMEWORK_QUEUE_MAX_ATTEMPTS: "4", HOMEWORK_AUTO_PUBLISH_ENABLED: "true",
  });
  const base = `http://localhost:${port}`; const bytes = testJpeg();
  try {
    await waitForServer(`${base}/api/auth/me`, worker);
    const teacherOneRegistration = await jsonRequest(base, "/api/auth/register", { method: "POST", body: { email: "one@homework.test", password: "password123", inviteCode: INVITE } });
    const teacherTwoRegistration = await jsonRequest(base, "/api/auth/register", { method: "POST", body: { email: "two@homework.test", password: "password123", inviteCode: INVITE } });
    assert.equal(teacherOneRegistration.response.status, 201); assert.equal(teacherTwoRegistration.response.status, 201);
    const teacherOne = sessionCookie(teacherOneRegistration.response); const teacherTwo = sessionCookie(teacherTwoRegistration.response);
    // Exercise the real V2 grading route through D1 and the homework queue.
    // Other roles retain the explicit read-only environment fallback in this suite.
    const adminRegistration = await jsonRequest(base, "/api/auth/register", { method: "POST", body: { email: "admin@homework.test", password: "password123", inviteCode: INVITE } });
    assert.equal(adminRegistration.response.status, 201);
    const adminCookie = sessionCookie(adminRegistration.response);
    const { newProvider } = await loadSource("lib/ai-provider-presets.ts");
    const providerResponse = await jsonRequest(base, "/api/admin/ai-providers", { cookie: adminCookie, method: "POST", body: {
      ...newProvider(), name: "Homework V2 fixture", baseUrl: `http://127.0.0.1:${modelPort}/v1`, wireApi: "responses", enabled: true, credential: { action: "replace", value: "mock-key" },
    } });
    assert.equal(providerResponse.response.status, 200); const gradingProvider = providerResponse.payload.provider;
    let center = (await jsonRequest(base, "/api/admin/ai-providers", { cookie: adminCookie })).payload;
    const modelResponse = await jsonRequest(base, `/api/admin/ai-providers/${gradingProvider.id}/models`, { cookie: adminCookie, method: "POST", body: {
      id: "mock-homework", expectedRevision: gradingProvider.revision, expectedConfigurationRevision: center.routing.revision,
      capabilities: { text: "supported", vision: "supported", structured: "supported" },
    } });
    assert.equal(modelResponse.response.status, 200);
    center = (await jsonRequest(base, "/api/admin/ai-providers", { cookie: adminCookie })).payload;
    center.routing.routes.find(route => route.role === "grading").primary = { providerId: gradingProvider.id, modelId: "mock-homework" };
    assert.equal((await jsonRequest(base, "/api/admin/ai-routing", { cookie: adminCookie, method: "PUT", body: center.routing })).response.status, 200);


    for (const path of ["/api/assignments", "/api/classes", "/api/student-portal", "/api/student-auth/me", "/api/student/assignments"]) {
      assert.equal((await jsonRequest(base, path, { cookie: teacherOne })).response.status, 404, `${path} is gone with homework assignment`);
    }

    const studentOne = await jsonRequest(base, "/api/students", { cookie: teacherOne, method: "POST", body: { student: { name: "小宇", className: "初一（1）班" } } });
    const studentTwo = await jsonRequest(base, "/api/students", { cookie: teacherOne, method: "POST", body: { student: { name: "小林", className: "初一（1）班" } } });
    assert.equal(studentOne.response.status, 201); assert.equal(studentTwo.response.status, 201);
    const studentOneId = studentOne.payload.student.id; const studentTwoId = studentTwo.payload.student.id;
    assert.equal((await jsonRequest(base, "/api/submissions", { cookie: teacherTwo, method: "POST", body: { studentId: studentOneId, title: "越权上传" } })).response.status, 404);

    const direct = await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:{studentId:studentOneId,title:"已完成作业直接批改"}});
    assert.equal(direct.response.status,201,JSON.stringify(direct.payload));
    const directId=direct.payload.submission.id,directAssignmentId=direct.payload.submission.assignmentId;
    assert.equal((await jsonRequest(base,`/api/submissions/${directId}`,{cookie:teacherTwo})).response.status,404);
    assert.equal((await upload(base,`/api/homework-assets?submissionId=${directId}&role=submission_processed`,teacherOne,bytes)).response.status,400);
    const directPage=await uploadPage(base,teacherOne,directId,bytes);
    assert.equal((await jsonRequest(base,`/api/submissions/${directId}`,{cookie:teacherTwo,method:"PUT",body:{action:"save-pages",pages:[directPage]}})).response.status,404);
    await submitPages(base,teacherOne,directId,[directPage]);
    const directResult=await waitForSubmission(base,teacherOne,directId,["published"],worker);
    assert.equal(directResult.pages[0].processedUrl,`/api/homework-assets/${directPage.assetId}`,"the uploaded photo is the page that is graded");
    assert.equal((await fetch(base+directResult.pages[0].processedUrl,{headers:{Cookie:teacherTwo}})).status,404);
    assert.equal(directResult.gradingSummary.incorrect,2);assert.equal(directResult.gradingSummary.partial,1);assert.equal(directResult.gradingSummary.unresolved,2);assert.equal(directResult.gradingSummary.archived,2);
    assert.deepEqual(directResult.gradingSummary.marks,{score:2.5,maxScore:11,pending:2,percentage:null},"pending questions stay in the denominator");
    assert.deepEqual(["D1","D2","D3"].map(n=>directResult.gradingItems.find(i=>i.questionNumber===n)).map(i=>[i.score,i.maxScore]),[[0,2],[2.5,4],[0,1]]);
    assert.ok(directResult.gradingItems.filter(i=>i.referenceVerified).every(i=>i.referenceSource==="agent"));
    assert.match(directResult.report.overallSummary,/本次作业已完成/);
    assert.deepEqual(directResult.outputs,{wrongBook:true,report:true,profile:false},"an upload without choices keeps the wrong book and report, and leaves the profile alone");
    assert.equal(d1Rows(stateDir,"SELECT COUNT(*) AS count FROM student_capability_evidence WHERE submission_id=?",[directId])[0].count,0);
    const d1Figures=directResult.gradingItems.find(i=>i.questionNumber==="D1").figures;
    assert.equal(d1Figures.length,1);assert.equal(directResult.figuresPending,0);
    const figureResponse=await fetch(base+d1Figures[0].url,{headers:{Cookie:teacherOne}});
    assert.equal(figureResponse.status,200);assert.equal(figureResponse.headers.get("content-type"),"image/jpeg");
    const figureImage=jpeg.decode(Buffer.from(await figureResponse.arrayBuffer()));
    assert.ok(figureImage.width>=165&&figureImage.width<=180&&figureImage.height>=65&&figureImage.height<=80,`${figureImage.width}x${figureImage.height}`);
    assert.equal((await fetch(base+d1Figures[0].url,{headers:{Cookie:teacherTwo}})).status,404);
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions`,{cookie:teacherOne,method:"POST",body:{questionIds:["anything"]}})).response.status,410);
    await jsonRequest(base,`/api/submissions/${directId}`,{cookie:teacherOne,method:"PUT",body:{action:"publish"}});
    assert.ok(d1Rows(stateDir,"SELECT * FROM student_wrong_occurrences WHERE submission_id=? AND active=1",[directId]).every(o=>o.active===1));
    await Promise.all([1,2].map(()=>jsonRequest(base,`/api/submissions/${directId}`,{cookie:teacherOne,method:"PUT",body:{action:"publish"}})));
    const directWrong=(await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions`,{cookie:teacherOne})).payload.entries;
    assert.equal(directWrong.filter(e=>e.assignmentId===directAssignmentId).length,2);
    assert.ok(directWrong.filter(e=>e.assignmentId===directAssignmentId).every(e=>e.mistakeCount===1&&e.answerCropAssetId));
    assert.deepEqual(directWrong.find(e=>e.assignmentId===directAssignmentId&&e.question.stem.includes("2+3")).question.contentImages,[d1Figures[0].url]);
    // Rows stay in the teacher's own namespace, so a re-sync of older homework updates them instead of adding copies.
    assert.ok(d1Rows(stateDir,"SELECT w.source_library_id AS library, s.owner_user_id AS owner FROM student_wrong_questions w JOIN students s ON s.id=w.student_id WHERE w.assignment_id=?",[directAssignmentId]).every(row=>row.library===`personal:${row.owner}`));
    const d1=directResult.gradingItems.find(i=>i.questionNumber==="D1");
    const correctedDirect=await jsonRequest(base,`/api/submissions/${directId}`,{cookie:teacherOne,method:"PUT",body:{action:"correct",items:[{id:d1.id,verdict:"partial",feedback:"教师确认部分正确"}]}});
    assert.equal(correctedDirect.response.status,200,JSON.stringify(correctedDirect.payload));
    assert.equal(correctedDirect.payload.submission.gradingSummary.archived,1);
    assert.equal(d1Rows(stateDir,"SELECT COUNT(*) AS count FROM grading_item_revisions WHERE submission_id=?",[directId])[0].count,1);
    const d2=directResult.gradingItems.find(i=>i.questionNumber==="D2");
    const rescored=(await jsonRequest(base,`/api/submissions/${directId}`,{cookie:teacherOne,method:"PUT",body:{action:"correct",items:[{id:d2.id,verdict:"partial",score:4}]}})).payload.submission.gradingItems.find(i=>i.id===d2.id);
    assert.deepEqual([rescored.verdict,rescored.score],["correct",4],"a full score makes the verdict correct");
    const remarked=(await jsonRequest(base,`/api/submissions/${directId}`,{cookie:teacherOne,method:"PUT",body:{action:"correct",items:[{id:d2.id,verdict:"correct",score:4,maxScore:5}]}})).payload.submission.gradingItems.find(i=>i.id===d2.id);
    assert.deepEqual([remarked.verdict,remarked.score,remarked.maxScore],["partial",4,5],"the teacher can supply the printed marks recognition missed");
    const directHistory=(await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions?includeHistory=true`,{cookie:teacherOne})).payload.entries;
    assert.ok(directHistory.some(e=>e.gradingItemId===d1.id&&e.archivedAt));
    const badReferences=await jsonRequest(base,`/api/submissions/${directId}`,{cookie:teacherOne,method:"PUT",body:{action:"correct",items:[{id:directResult.gradingItems.find(i=>i.questionNumber==="D5").id,verdict:"incorrect"}]}});
    assert.equal(badReferences.response.status,400);
    const oldPage=directResult.pages[0];
    const supplemental=await uploadPage(base,teacherOne,directId,bytes);
    mock.state.supplementalReadable=true;
    const beforeKnown=d1Rows(stateDir,"SELECT id,updated_at FROM grading_items WHERE submission_id=? AND requires_review=0 ORDER BY id",[directId]);
    const supplementalResult=await jsonRequest(base,`/api/submissions/${directId}`,{cookie:teacherOne,method:"PUT",body:{action:"reprocess-pending",pages:[{...supplemental,replacePageId:oldPage.id}]}});
    assert.equal(supplementalResult.response.status,200,JSON.stringify(supplementalResult.payload));
    const reprocessed=await waitForSubmission(base,teacherOne,directId,["published"],worker);
    assert.equal(reprocessed.gradingItems.find(i=>i.questionNumber==="D4").verdict,"correct");
    assert.equal(reprocessed.gradingSummary.unresolved,1);
    assert.equal(reprocessed.pageRevisions.length,1);
    assert.equal(reprocessed.pageRevisions[0].originalUrl,oldPage.originalUrl);
    assert.deepEqual(d1Rows(stateDir,"SELECT id,updated_at FROM grading_items WHERE submission_id=? AND id IN ("+beforeKnown.map(()=>"?").join(",")+") ORDER BY id",[directId,...beforeKnown.map(i=>i.id)]),beforeKnown);

    const withReference=await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:{studentId:studentTwoId,title:"直接批改参考答案验证",outputs:{wrongBook:false,report:false,profile:true}}});
    const providedId=withReference.payload.submission.id;
    const providedAssignment=withReference.payload.submission.assignmentId;
    for(let page=0;page<2;page++)assert.equal((await upload(base,`/api/homework-assets?assignmentId=${providedAssignment}&role=answer`,teacherOne,bytes,`参考答案-${page+1}.jpg`)).response.status,201);
    assert.deepEqual(d1Rows(stateDir,"SELECT page_order FROM assignment_assets WHERE assignment_id=? ORDER BY page_order",[providedAssignment]).map(row=>row.page_order),[0,1],"reference pages append in upload order");
    assert.equal((await upload(base,`/api/homework-assets?assignmentId=${providedAssignment}&role=answer`,teacherTwo,bytes)).response.status,404);
    await submitPages(base,teacherOne,providedId,[await uploadPage(base,teacherOne,providedId,bytes)]);
    const provided=await waitForSubmission(base,teacherOne,providedId,["published"],worker);
    assert.ok(provided.gradingItems.filter(i=>i.referenceVerified).every(i=>i.referenceSource==="provided"));
    // Only the chosen outputs run: the profile gains evidence while the wrong book and report stay untouched.
    assert.deepEqual(provided.outputs,{wrongBook:false,report:false,profile:true});
    assert.equal(provided.report,null);assert.equal(provided.gradingSummary.archived,0);
    assert.equal((await jsonRequest(base,`/api/students/${studentTwoId}/wrong-questions`,{cookie:teacherOne})).payload.entries.length,0);
    assert.ok(d1Rows(stateDir,"SELECT COUNT(*) AS count FROM student_capability_evidence WHERE submission_id=?",[providedId])[0].count>0);
    const overlay=(await jsonRequest(base,`/api/knowledge-graph?studentId=${studentTwoId}`,{cookie:teacherOne})).payload.profile;
    assert.ok(overlay.nodes.some(node=>node.evidenceCount>0),"the knowledge-graph overlay shows the integrated homework");
    // Homework read with figures has nothing to fill in; the action belongs to the owning teacher only.
    assert.equal(provided.figuresPending,0);
    assert.equal((await jsonRequest(base,`/api/submissions/${providedId}`,{cookie:teacherTwo,method:"PUT",body:{action:"attach-figures"}})).response.status,404);
    const filled=await jsonRequest(base,`/api/submissions/${providedId}`,{cookie:teacherOne,method:"PUT",body:{action:"attach-figures"}});
    assert.equal(filled.response.status,200,JSON.stringify(filled.payload));assert.equal(mock.state.locatorCalls,0);
    const ownWrong=(await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions`,{cookie:teacherOne})).payload.entries;
    assert.equal(ownWrong.some(e=>e.assignmentId===providedAssignment),false);
    assert.equal((await jsonRequest(base,`/api/submissions/${providedId}`,{cookie:teacherTwo,method:"PUT",body:{action:"correct",items:[]}})).response.status,404);

    const versions=await jsonRequest(base,`/api/submissions/${directId}`,{cookie:teacherOne,method:"PUT",body:{action:"new-version"}});
    assert.equal(versions.response.status,200);assert.equal(versions.payload.submission.version,2);
    const secondId=versions.payload.submission.id;
    await submitPages(base,teacherOne,secondId,[await uploadPage(base,teacherOne,secondId,bytes)]);
    const secondResult=await waitForSubmission(base,teacherOne,secondId,["published"],worker);
    let d3entry=(await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions`,{cookie:teacherOne})).payload.entries.find(e=>e.assignmentId===directAssignmentId&&e.question.stem.includes("3+3"));
    assert.equal(d3entry.mistakeCount,2);
    const secondD3=secondResult.gradingItems.find(i=>i.questionNumber==="D3");
    await jsonRequest(base,`/api/submissions/${secondId}`,{cookie:teacherOne,method:"PUT",body:{action:"correct",items:[{id:secondD3.id,verdict:"correct",studentAnswer:"6"}]}});
    d3entry=(await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions`,{cookie:teacherOne})).payload.entries.find(e=>e.assignmentId===directAssignmentId&&e.question.stem.includes("3+3"));
    assert.equal(d3entry.mistakeCount,1);assert.equal(d3entry.submissionId,directId);
    // A deleted wrong question waits in history, stays there when older grading is re-synced, and can be restored.
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions/${d3entry.id}`,{cookie:teacherTwo,method:"DELETE"})).response.status,404);
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions/${d3entry.id}`,{cookie:teacherOne,method:"DELETE"})).response.status,200);
    const wrongIds=async()=>(await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions`,{cookie:teacherOne})).payload.entries.map(e=>e.id);
    assert.equal((await wrongIds()).includes(d3entry.id),false);
    await jsonRequest(base,`/api/submissions/${secondId}`,{cookie:teacherOne,method:"PUT",body:{action:"correct",items:[{id:secondD3.id,verdict:"correct",studentAnswer:"6"}]}});
    assert.equal((await wrongIds()).includes(d3entry.id),false,"re-syncing earlier grading does not undo the deletion");
    const deletedEntry=(await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions?includeHistory=true`,{cookie:teacherOne})).payload.entries.find(e=>e.id===d3entry.id);
    assert.equal(deletedEntry.archiveReason,"老师删除");
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions/${d3entry.id}`,{cookie:teacherOne,method:"PATCH"})).response.status,200);
    assert.equal((await wrongIds()).includes(d3entry.id),true);
    assert.deepEqual((await jsonRequest(base,"/api/submissions",{cookie:teacherOne})).payload.submissions.map(item=>item.id).sort(),[directId,providedId,secondId].sort());

    mock.state.multiPage=true;mock.state.invalidPage=4;mock.state.pageExtractionCalls={};
    const international=await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:{studentId:studentTwoId,title:"9709 P1 Quiz",curriculum:"international"}});
    assert.equal(international.payload.submission.curriculum,"international");
    const internationalId=international.payload.submission.id;
    await submitPages(base,teacherOne,internationalId,[await uploadPage(base,teacherOne,internationalId,bytes)]);
    const graded=await waitForSubmission(base,teacherOne,internationalId,["published"],worker);
    assert.deepEqual(graded.gradingItems.map(i=>[i.questionNumber,i.verdict,i.score,i.maxScore]),[["1(a)","correct",2,2],["1(b)","partial",1,3],["2","unreadable",0,4]],"sub-parts keep their printed numbers and an unreadable answer scores 0");
    assert.equal(graded.gradingItems.find(i=>i.questionNumber==="2").requiresReview,true,"the unreadable answer still waits for a clearer photo");
    assert.deepEqual(graded.gradingSummary.marks,{score:3,maxScore:9,pending:0,percentage:33.3});
    assert.equal(graded.gradingSummary.archived,0,"neither a partial nor an unreadable answer enters the wrong book");
    assert.deepEqual(graded.report.details.losses.map(l=>l.questionNumbers),[["1(b)"],["2"]],"the unreadable sub-part the model left out is still reported");
    assert.equal(graded.report.overallSummary,"第 1(a) 题完成稳定，优先补全第 1(b) 题。");
    assert.equal(directResult.curriculum,"school");assert.equal(directResult.report.details,null);

    const multi=await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:{studentId:studentOneId,title:"多页完整性截断回归"}});
    const multiId=multi.payload.submission.id,multiPages=[];
    for(let page=0;page<5;page++)multiPages.push(await uploadPage(base,teacherOne,multiId,bytes));
    await submitPages(base,teacherOne,multiId,multiPages);
    const incomplete=await waitForSubmission(base,teacherOne,multiId,["failed"],worker);
    assert.ok(incomplete.pageCoverage.processed<5);assert.ok(incomplete.pageCoverage.missing.includes(4));
    assert.equal((await jsonRequest(base,`/api/submissions/${multiId}`,{cookie:teacherOne,method:"PUT",body:{action:"publish"}})).response.status,409);
    const beforeCalls={...mock.state.pageExtractionCalls};mock.state.invalidPage=0;
    await jsonRequest(base,`/api/submissions/${multiId}`,{cookie:teacherOne,method:"PUT",body:{action:"retry"}});
    const recovered=await waitForSubmission(base,teacherOne,multiId,["published"],worker);
    assert.equal(recovered.pageCoverage.processed,5);assert.equal(recovered.gradingItems.length,5);
    assert.equal(mock.state.pageExtractionCalls[1],beforeCalls[1]);assert.equal(mock.state.pageExtractionCalls[4],beforeCalls[4]+1);
    await jsonRequest(base,`/api/submissions/${multiId}`,{cookie:teacherOne,method:"PUT",body:{action:"rebuild-coverage"}});
    const rebuilt=await waitForSubmission(base,teacherOne,multiId,["published"],worker);
    assert.equal(rebuilt.processingProgress.graded,5,"historical grading rows must not falsely finish a new run");
    assert.ok(d1Rows(stateDir,"SELECT g.updated_at>=s.submitted_at AS fresh FROM grading_items g JOIN homework_submissions s ON s.id=g.submission_id WHERE g.submission_id=?",[multiId]).every(g=>g.fresh===1));
    mock.state.multiPage=false;

    // Ticks and crosses the teacher already made decide those questions; only the unmarked one is solved and judged, without written analysis.
    mock.state.teacherMarked="merged";mock.state.referenceNumbers=[];mock.state.gradedNumbers=[];
    const marked=await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:{studentId:studentOneId,title:"老师已批改的练习",outputs:{wrongBook:true,report:false,profile:false}}});
    const markedId=marked.payload.submission.id;
    await submitPages(base,teacherOne,markedId,[await uploadPage(base,teacherOne,markedId,bytes)]);
    const markedResult=await waitForSubmission(base,teacherOne,markedId,["published"],worker);
    assert.deepEqual(markedResult.gradingItems.map(i=>[i.questionNumber,i.verdict,i.teacherMark,i.evidenceSummary]),[["1-3(1)","correct","correct","老师已打勾"],["1-3(2)","incorrect","incorrect","老师已打叉或圈出答案"],["1-4","incorrect",null,""]]);
    assert.deepEqual([mock.state.referenceNumbers,mock.state.gradedNumbers],[["1-4"],["1-4"]],"marked sub-questions are neither solved nor judged by the model");
    assert.ok(mock.state.verdictOnlyPrompts>0);
    const unmarked=markedResult.gradingItems.find(i=>i.questionNumber==="1-4");
    assert.deepEqual([unmarked.feedback,unmarked.stepAnalysis,unmarked.errorType,unmarked.standardAnswer,unmarked.standardAnalysis],["",[],"","5",""],"school homework keeps only the verdict and the final answer");
    assert.equal(markedResult.gradingSummary.archived,2,"the teacher's cross files the sub-question without a reference answer");
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions`,{cookie:teacherOne})).payload.entries.filter(e=>e.assignmentId===markedResult.assignmentId).length,2);
    const misread=await jsonRequest(base,`/api/submissions/${markedId}`,{cookie:teacherOne,method:"PUT",body:{action:"correct",items:[{id:markedResult.gradingItems.find(i=>i.questionNumber==="1-3(2)").id,verdict:"correct"}]}});
    assert.equal(misread.response.status,200,"a misread mark is corrected without supplying a reference answer");
    assert.equal(misread.payload.submission.gradingSummary.archived,1);

    // Read again as sub-questions, the old 1-4 passes its record to 1-4(1) instead of lingering as a pending question.
    mock.state.teacherMarked="split";mock.state.referenceNumbers=[];
    const version=await jsonRequest(base,`/api/submissions/${markedId}`,{cookie:teacherOne,method:"PUT",body:{action:"new-version"}});
    const versionId=version.payload.submission.id;
    await submitPages(base,teacherOne,versionId,[await uploadPage(base,teacherOne,versionId,bytes)]);
    const split=await waitForSubmission(base,teacherOne,versionId,["published"],worker);
    assert.deepEqual(split.gradingItems.map(i=>[i.questionNumber,i.verdict]),[["1-3(1)","correct"],["1-3(2)","incorrect"],["1-4(1)","incorrect"],["1-4(2)","correct"]]);
    assert.equal(split.gradingItems.find(i=>i.questionNumber==="1-4(1)").assignmentQuestionId,unmarked.assignmentQuestionId);
    assert.deepEqual(mock.state.referenceNumbers,["1-4(1)"]);
    mock.state.teacherMarked="";

    mock.state.failAll=true;
    const failing=await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:{studentId:studentTwoId,title:"队列失败恢复"}});
    const failedId=failing.payload.submission.id;
    await submitPages(base,teacherOne,failedId,[await uploadPage(base,teacherOne,failedId,bytes)]);
    // Between queue attempts the submission stays in progress with a retry note and refuses a manual retry; only the last attempt marks it failed.
    const diagnosticsQuery = `SELECT role,model_id,MAX(upper_attempt) AS attempts FROM ai_provider_diagnostics WHERE provider_id='${gradingProvider.id}' AND kind='task' AND code='UPSTREAM_FAILED'`;
    const retryDeadline = Date.now() + 30_000; let retryNote = "", manualRetryStatus = 0;
    while (Date.now() < retryDeadline && Number(d1Rows(stateDir, diagnosticsQuery)[0]?.attempts ?? 0) < 4) {
      const current = (await jsonRequest(base, `/api/submissions/${failedId}`, { cookie: teacherOne })).payload.submission;
      const attempts = Number(d1Rows(stateDir, diagnosticsQuery)[0]?.attempts ?? 0);
      assert.ok(current.status !== "failed" || attempts >= 4, `第 ${attempts} 次尝试后队列还会重试，不应标记为处理失败`);
      if (!retryNote && current.status === "processing" && current.failureReason) {
        retryNote = current.failureReason;
        manualRetryStatus = (await jsonRequest(base, `/api/submissions/${failedId}`, { cookie: teacherOne, method: "PUT", body: { action: "retry" } })).response.status;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    assert.match(retryNote, /^AI 服务中断，正在自动重试（第 [1-3] 次重试，最多 3 次）$/);
    assert.equal(manualRetryStatus, 409, "a manual retry must not start a second run while the queue is retrying");
    const failed = await waitForSubmission(base, teacherOne, failedId, ["failed"], worker, 30_000);
    assert.match(failed.failureReason, /上游服务失败/); assert.doesNotMatch(failed.failureReason, /mock grading unavailable/); assert.ok(mock.state.failureCalls >= 4);
    const diagnosticRows = d1Rows(stateDir, diagnosticsQuery);
    assert.equal(diagnosticRows[0].role, "grading"); assert.equal(diagnosticRows[0].model_id, "mock-homework"); assert.equal(diagnosticRows[0].attempts, 4);
    mock.state.failAll = false;
    assert.equal((await jsonRequest(base, `/api/submissions/${failedId}`, { cookie: teacherOne, method: "PUT", body: { action: "retry" } })).response.status, 200);
    const recoveredFailure = await waitForSubmission(base, teacherOne, failedId, ["published"], worker);

    assert.equal((await jsonRequest(base, `/api/students/${studentTwoId}`, { cookie: teacherOne, method: "DELETE", body: {} })).response.status, 200);
    const cleanupDeadline = Date.now() + 10_000; let cleanupStatus = "";
    while (Date.now() < cleanupDeadline) {
      cleanupStatus = String(d1Rows(stateDir, "SELECT status FROM homework_asset_cleanup_jobs ORDER BY created_at DESC LIMIT 1")[0]?.status ?? "");
      if (cleanupStatus === "completed") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    assert.equal(cleanupStatus, "completed");
    assert.equal((await fetch(`${base}${recoveredFailure.pages[0].processedUrl}`, { headers: { Cookie: teacherOne } })).status, 404);
  } catch (error) {
    console.error(worker.output());
    throw error;
  } finally {
    await stopWorker(worker); mock.server.closeAllConnections(); await new Promise((resolveClose) => mock.server.close(resolveClose));
  }
});
