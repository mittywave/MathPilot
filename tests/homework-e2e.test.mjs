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
  const state = { failAll: false, failureCalls: 0, gradingCalls: 0, supplementalReadable:false,multiPage:false,pageQuestionCount:1,concurrency:null,verificationGate:null,invalidPage:0,pageExtractionCalls:{},pageImageCounts:[],contextProbe:false,renumberPage:0,locatorCalls:0,teacherMarked:"",referenceNumbers:[],gradedNumbers:[],verdictOnlyPrompts:0,assignedPage:[],assignedPrompts:[],assignedAnswers:{},assignedVerdicts:{},observationPrompts:[],failObservation:false };
  const server = createHttpServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const prompt = String(payload.input?.[0]?.content?.find((item) => item.type === "input_text")?.text ?? "");
    if (state.concurrency) {
      const stage = prompt.includes("只识别学生已完成的数学作业") ? "pages"
        : prompt.includes("建立独立参考解答") ? "reference"
        : prompt.includes("独立核验参考答案") ? "verification"
        : prompt.includes("本次是已完成作业直接批改") ? "grading" : null;
      if (stage) {
        const metrics = state.concurrency;
        if (stage === "reference") assert.equal(metrics.finished.pages, 5, "references wait for all page receipts");
        const numbers = stage === "grading" ? [...prompt.matchAll(/题号 ([^\n]+)/g)].map(m=>m[1].trim())
          : [...new Set([...prompt.matchAll(/"question_number":"([^"]+)"/g)].map(m=>m[1]))];
        if (stage === "grading") {
          assert.ok(numbers.every(number=>metrics.verified.has(number)), "only verified questions enter grading");
          if(metrics.verified.size<25)metrics.earlyGrading=true;
        }
        metrics.active[stage] = (metrics.active[stage] ?? 0) + 1;
        metrics.peak[stage] = Math.max(metrics.peak[stage] ?? 0, metrics.active[stage]);
        metrics.total += 1; metrics.totalPeak = Math.max(metrics.totalPeak, metrics.total);
        response.once("finish", () => {
          metrics.active[stage] -= 1; metrics.total -= 1;
          metrics.finished[stage] = (metrics.finished[stage] ?? 0) + 1;
          if(stage === "verification" && response.statusCode === 200)numbers.forEach(number=>metrics.verified.add(number));
        });
        // Keep requests in flight long enough to observe the actual queue's worker slots.
        await new Promise(resolveDelay => setTimeout(resolveDelay, 1000));
      }
    }
    if (state.failAll && prompt.includes("只识别学生已完成的数学作业")) {
      state.failureCalls += 1; response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: "mock grading unavailable" } })); return;
    }
    // 定档 · 主观: the teacher's words read against the five abilities; one judgement and one keyword quote nothing the teacher said.
    if (prompt.includes("老师课后口述了一段对学生的观察")) {
      if (state.failObservation) { response.writeHead(401,{"Content-Type":"application/json"});response.end(JSON.stringify({error:{message:"mock observation refused"}}));return; }
      state.observationPrompts.push(prompt);
      response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({output_text:JSON.stringify({abilities:[{key:"careless",polarity:"weakness",evidence:"还是粗心"},{key:"thinking-reverse",polarity:"strength",evidence:"逆向思维 不错"},{key:"calculation",polarity:"weakness",evidence:"老师没说过的话"}],keywords:["丢负号","老师没说的词"]})}));return;
    }
    // An assigned sheet is read against its list: the page names the sheet's own numbers (in any of their written forms).
    if (prompt.includes("只识别学生已完成的数学作业") && prompt.includes("这是老师布置的练习")) {
      state.assignedPrompts.push(prompt);
      const questions=state.assignedPage.map(q=>({page_numbers:[1],type:"填空题",stem:"",options:[],student_answer:"",answer_state:"readable",question_complete:true,max_score:null,bbox:{x:90,y:120,width:700,height:90},knowledge_tags:[],capability_keys:[],figures:[],figure_notes:"",teacher_mark:"none",...q}));
      response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({output_text:JSON.stringify({questions,page:{page_number:1,kind:"questions",question_numbers:questions.map(q=>q.question_number),reason:""}})}));return;
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
      const context=prompt.includes('当前任务只补全已独立识别');
      if(!context)state.pageImageCounts.push(payload.input[0].content.filter(item=>item.type==='input_image').length);
      state.pageExtractionCalls[primary]=(state.pageExtractionCalls[primary]??0)+1;
      // A worksheet the teacher already marked: question 3 has two sub-questions, the printed (1) still without its page prefix.
      const marked=[
        {question_number:"3(1)",page_numbers:[1],type:"填空题",stem:"3. 计算：(1) 1+1",options:[],student_answer:"2",answer_state:"readable",question_complete:true,teacher_mark:"correct"},
        {question_number:"1-3(2)",page_numbers:[1],type:"填空题",stem:"3. 在(1)的条件下，计算：(2) 2+2",options:[],student_answer:"5",answer_state:"readable",question_complete:true,teacher_mark:state.teacherMarked==="partial"?"partial":"incorrect"},
        ...(state.teacherMarked==="split"?[
          {question_number:"1-4(1)",page_numbers:[1],type:"填空题",stem:"4. 计算：(1) 4+4",options:[],student_answer:"9",answer_state:"readable",question_complete:true,teacher_mark:"none"},
          {question_number:"1-4(2)",page_numbers:[1],type:"填空题",stem:"4. 计算：(2) 5+5",options:[],student_answer:"10",answer_state:"readable",question_complete:true,teacher_mark:"correct"},
        ]:[{question_number:"1-4",page_numbers:[1],type:"填空题",stem:"4. 计算 4+4",options:[],student_answer:"9",answer_state:"readable",question_complete:true,teacher_mark:"none"}]),
      ];
      const questions=(state.teacherMarked?marked:state.multiPage?Array.from({length:state.pageQuestionCount},(_,index)=>({question_number:`${primary}-${index+1}`,page_numbers:[primary],type:"填空题",stem:"计算 2+3",options:[],student_answer:"6",answer_state:"readable",question_complete:true})):[
        {question_number:"D1",page_numbers:[1],type:"填空题",stem:"计算 2+3",options:[],student_answer:"6",answer_state:"readable",question_complete:true},
        {question_number:"D2",page_numbers:[1],type:"解答题",stem:"求解 x+1=3 并验算",options:[],student_answer:"移项到x=2",answer_state:"readable",question_complete:true},
        {question_number:"D3",page_numbers:[1],type:"填空题",stem:"计算 3+3",options:[],student_answer:"",answer_state:"blank",question_complete:true},
        {question_number:"D4",page_numbers:[1],type:"填空题",stem:"计算 4+4",options:[],student_answer:state.supplementalReadable?"8":"",answer_state:state.supplementalReadable?"readable":"unreadable",question_complete:true},
        {question_number:"D5",page_numbers:[1],type:"解答题",stem:"条件不完整",options:[],student_answer:"10",answer_state:"readable",question_complete:false},
      ]).map(q=>({teacher_mark:"none",...q,max_score:({D1:2,D2:4,D3:1,D4:1,D5:3}[q.question_number]??null),bbox:{x:90,y:100,width:700,height:100},knowledge_tags:["有理数运算"],capability_keys:["skill:calculation"],
        figures:q.question_number==="D1"?[{kind:"stem",bbox:{x:660,y:240,width:180,height:50},hasHandwriting:false}]:[],figure_notes:q.question_number==="D1"?"坐标轴":""}));
      if(state.contextProbe && primary===3){
        if(context){questions[0].bbox={x:700,y:800,width:100,height:100};questions[0].teacher_mark='correct';questions[0].student_answer='邻页答案';}
        else questions[0].question_complete=false;
      }
      if(state.renumberPage===primary)questions[0].question_number=`${primary}-2`;
      response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({output_text:JSON.stringify({questions,page:{page_number:state.invalidPage===primary?1:primary,kind:"questions",question_numbers:questions.map(q=>q.question_number),reason:""}})}));return;
    }
    if(prompt.includes("作业配图定位助手")) {state.locatorCalls+=1;const numbers=[...prompt.matchAll(/^([^\n：]+)：/gm)].map(m=>m[1]).filter(n=>/^D\d$/.test(n));response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({output_text:JSON.stringify({questions:numbers.map(question_number=>({question_number,figures:question_number==='D1'?[{kind:'stem',bbox:{x:660,y:240,width:180,height:50},hasHandwriting:true}]:[],added_texts:[]}))})}));return;}
    if(prompt.includes("建立独立参考解答")) {
      assert.doesNotMatch(prompt,/student_answer/);
      const numbers=[...new Set([...prompt.matchAll(/"question_number":"([^"]+)"/g)].map(m=>m[1]))];state.referenceNumbers.push(...numbers);
      if(numbers.includes("1-3(2)"))assert.match(prompt,/本题引用的第\(1\)问条件[\s\S]*3. 计算：\(1\) 1\+1/);
      const answers=numbers.map(n=>({question_number:n,answer:({D1:"5",D2:"x=2",D3:"6",D4:"8"}[n]??"5"),analysis:"独立验算推导",source:prompt.includes("提供的 0 张")?"agent":"provided"}));
      response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({output_text:JSON.stringify({answers})}));return;
    }
    if(prompt.includes("独立核验参考答案")) {
      const gate=state.verificationGate;
      if(gate&&prompt.includes('"question_number":"1-1"')){
        gate.sizes.push([...new Set([...prompt.matchAll(/"question_number":"([^"]+)"/g)].map(m=>m[1]))].length);
        if(!gate.entered){
          gate.entered=true;
          await new Promise(resolveGate=>{gate.release=resolveGate;});
          response.writeHead(503,{"Content-Type":"application/json"});response.end(JSON.stringify({error:{message:"verification fixture interruption"}}));return;
        }
      }
      assert.doesNotMatch(prompt,/student_answer/);
      const numbers=[...new Set([...prompt.matchAll(/"question_number":"([^"]+)"/g)].map(m=>m[1]))];
      const results=numbers.map(n=>({question_number:n,verified:true,reason:n==="1-4"?"":"已独立验算成立"}));
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
      if(numbers.includes("1(b)"))assert.match(prompt, /题号 1\(b\)\n题型：解答题\n满分：3/); assert.match(prompt, /结果分（A）只在对应方法分已得时才给/);
      const results = numbers.map((number) => ({ question_number: number, page_number: 1, student_answer: number === "1(a)" ? "x=2" : "x^2=2", verdict: number === "1(a)" ? "correct" : "partial", score: number === "1(a)" ? 2 : 1,
        feedback: number === "1(a)" ? "" : "方法分已得，结果算错。", error_type: number === "1(a)" ? "" : "计算", step_analysis: number === "1(a)" ? ["M1 ✓", "A1 ✓"] : ["M1 ✓", "A1 ✗", "A1 ✗"], evidence_summary: "", capability_keys: [], confidence: .9, bbox: null, warnings: [] }));
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ output_text: JSON.stringify({ results }) })); return;
    }
    if (numbers.includes("D2")) assert.match(prompt, /题号 D2\n题型：解答题\n满分：4/);
    const results = numbers.map((number, index) => ({
      question_number: number, page_number: 1, student_answer: state.assignedAnswers[number] ?? (state.teacherMarked && /^1-4(?:\(1\))?$/.test(number) ? "9" : /^[1-5]-[1-5]$/.test(number) ? "6" : number === "D1" ? "6" : number === "D4" ? "8" : number === "D2" ? "移项到x=2" : "B"),
      verdict: state.assignedVerdicts[number] ?? (number === "D2" ? "partial" : "incorrect"), score: number === "D2" ? 2.5 : 0, feedback: number === "D2" ? "推导未完成" : "结果与参考答案不同",
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
    // Existing figures can be independently relocated; only the owning teacher can do so.
    assert.equal(provided.figuresPending,0);
    assert.equal((await jsonRequest(base,`/api/submissions/${providedId}`,{cookie:teacherTwo,method:"PUT",body:{action:"attach-figures"}})).response.status,404);
    const filled=await jsonRequest(base,`/api/submissions/${providedId}`,{cookie:teacherOne,method:"PUT",body:{action:"attach-figures"}});
    assert.equal(filled.response.status,200,JSON.stringify(filled.payload));assert.equal(mock.state.locatorCalls,1);
    assert.equal(filled.payload.submission.gradingItems.find(i=>i.questionNumber==='D1').figures[0].hasHandwriting,true);
    const locatedCache=JSON.parse(d1Rows(stateDir,'SELECT result_json FROM submission_page_extractions WHERE submission_id=?',[providedId])[0].result_json).questions.find(q=>q.question_number==='D1');
    assert.equal(locatedCache.figures[0].hasHandwriting,true);assert.equal(locatedCache.figures[0].sourceAssetId,provided.pages[0].processedAssetId);
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

    mock.state.contextProbe=true;
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
    assert.ok(mock.state.pageImageCounts.every(count=>count===1),'school page inventories never see adjacent images');
    const anchored=JSON.parse(d1Rows(stateDir,'SELECT result_json FROM submission_page_extractions WHERE submission_id=?',[multiId]).find(row=>JSON.parse(row.result_json).pageNumber===3).result_json).questions[0];
    assert.deepEqual(anchored.bbox,{x:90,y:100,width:700,height:100});assert.equal(anchored.teacher_mark,'none');assert.equal(anchored.student_answer,'6');
    assert.deepEqual(anchored.page_numbers,[3]);assert.equal(anchored.question_complete,true);
    mock.state.contextProbe=false;
    assert.equal(mock.state.pageExtractionCalls[1],beforeCalls[1]);assert.equal(mock.state.pageExtractionCalls[4],beforeCalls[4]+1);
    await jsonRequest(base,`/api/submissions/${multiId}`,{cookie:teacherOne,method:"PUT",body:{action:"rebuild-coverage"}});
    const rebuilt=await waitForSubmission(base,teacherOne,multiId,["published"],worker);
    assert.equal(rebuilt.processingProgress.graded,5,"historical grading rows must not falsely finish a new run");
    assert.ok(d1Rows(stateDir,"SELECT g.updated_at>=s.submitted_at AS fresh FROM grading_items g JOIN homework_submissions s ON s.id=g.submission_id WHERE g.submission_id=?",[multiId]).every(g=>g.fresh===1));
    // A corrected inventory withdraws a phantom question without deleting its audit history.
    const superseded=rebuilt.gradingItems.find(item=>item.questionNumber==='3-1');
    mock.state.renumberPage=3;
    command(['d1','execute','DB','--local','--persist-to',stateDir,'--config',join(ROOT,'wrangler.jsonc'),'--command',`UPDATE submission_page_extractions SET status='failed' WHERE submission_id='${multiId}' AND json_extract(result_json,'$.pageNumber')=3`]);
    await jsonRequest(base,`/api/submissions/${multiId}`,{cookie:teacherOne,method:'PUT',body:{action:'rebuild-coverage'}});
    const reread=await waitForSubmission(base,teacherOne,multiId,['published'],worker);
    assert.deepEqual(reread.gradingItems.map(item=>item.questionNumber),['1-1','2-1','3-2','4-1','5-1']);
    assert.equal(reread.processingProgress.identified,5);assert.equal(reread.processingProgress.graded,5);
    assert.equal(d1Rows(stateDir,'SELECT active FROM student_wrong_occurrences WHERE grading_item_id=?',[superseded.id])[0].active,0);
    assert.equal(d1Rows(stateDir,'SELECT COUNT(*) AS n FROM grading_items WHERE id=?',[superseded.id])[0].n,1);
    assert.ok(d1Rows(stateDir,'SELECT COUNT(*) AS n FROM grading_item_revisions WHERE grading_item_id=?',[superseded.id])[0].n>0);
    mock.state.renumberPage=0;
    // Five pages and 25 questions exercise four slots plus queued work in every AI stage.
    mock.state.pageQuestionCount=5;
    mock.state.concurrency={active:{},peak:{},finished:{},total:0,totalPeak:0,verified:new Set(),earlyGrading:false};
    const parallel=await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:{studentId:studentOneId,title:"四路并发回归",outputs:{wrongBook:true,report:false,profile:false}}});
    const parallelId=parallel.payload.submission.id,parallelPages=[];
    for(let page=0;page<5;page++)parallelPages.push(await uploadPage(base,teacherOne,parallelId,bytes));
    await submitPages(base,teacherOne,parallelId,parallelPages);
    const parallelResult=await waitForSubmission(base,teacherOne,parallelId,["published"],worker);
    assert.deepEqual(mock.state.concurrency.peak,{pages:4,reference:4,verification:4,grading:4});
    assert.equal(mock.state.concurrency.totalPeak,4,"solve, verification and grading share four worker slots");
    assert.equal(mock.state.concurrency.earlyGrading,true,"a ready batch is graded before the final reference batch");
    assert.deepEqual(mock.state.concurrency.finished,{pages:5,reference:5,verification:5,grading:5});
    assert.equal(parallelResult.pageCoverage.processed,5);
    assert.equal(parallelResult.gradingItems.length,25);
    assert.equal(parallelResult.gradingSummary.archived,25);
    assert.equal(new Set(parallelResult.gradingItems.map(item=>item.questionNumber)).size,25);
    assert.ok(parallelResult.gradingItems.every(item=>item.verdict==="incorrect"));
    console.log("Homework concurrency peaks:",mock.state.concurrency.peak,"; saved and archived:",parallelResult.gradingItems.length);
    // Hold one verification open: the other 20 questions must finish, while five drafts cannot count as checked.
    mock.state.concurrency={active:{},peak:{},finished:{},total:0,totalPeak:0,verified:new Set(),earlyGrading:false};
    mock.state.verificationGate={entered:false,release:null,sizes:[]};
    mock.state.referenceNumbers=[];mock.state.gradedNumbers=[];mock.state.pageExtractionCalls={};
    const resumed=await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:{studentId:studentOneId,title:"核验中断续跑",outputs:{wrongBook:true,report:false,profile:false}}});
    const resumedId=resumed.payload.submission.id,resumedPages=[];
    for(let page=0;page<5;page++)resumedPages.push(await uploadPage(base,teacherOne,resumedId,bytes));
    await submitPages(base,teacherOne,resumedId,resumedPages);
    let partial;const partialDeadline=Date.now()+20_000;
    while(Date.now()<partialDeadline){
      partial=(await jsonRequest(base,`/api/submissions/${resumedId}`,{cookie:teacherOne})).payload.submission;
      if(partial.processingProgress.graded===20)break;
      await new Promise(resolveWait=>setTimeout(resolveWait,150));
    }
    assert.equal(partial.status,"processing");
    assert.equal(partial.processingProgress.referenceChecked,20,"generated but unverified drafts are not counted as ready");
    assert.equal(partial.processingProgress.graded,20,"the slow first batch does not block queued batches");
    assert.equal(partial.gradingSummary.archived,0,"partial processing must not publish the paper early");
    const savedBefore=new Map(partial.gradingItems.map(item=>[item.id,item.updatedAt]));
    assert.equal(d1Rows(stateDir,"SELECT count(*) n FROM assignment_questions WHERE assignment_id=? AND reference_fingerprint LIKE 'pending:%' AND reference_verified=0",[partial.assignmentId])[0].n,5);
    mock.state.verificationGate.release();
    const resumedResult=await waitForSubmission(base,teacherOne,resumedId,["published"],worker);
    assert.deepEqual(mock.state.verificationGate.sizes,[5,2],"the failed five-question batch is split on the next queue attempt");
    assert.equal(mock.state.referenceNumbers.length,25,"verification retry reuses generated answers");
    assert.equal(new Set(mock.state.referenceNumbers).size,25);
    assert.equal(mock.state.gradedNumbers.length,25,"saved verdicts are never graded twice");
    assert.equal(mock.state.concurrency.totalPeak,4);
    assert.equal(resumedResult.processingProgress.referenceChecked,25);
    assert.equal(resumedResult.gradingSummary.archived,25);
    assert.ok(resumedResult.gradingItems.every(item=>!savedBefore.has(item.id)||savedBefore.get(item.id)===item.updatedAt));
    assert.deepEqual(Object.values(mock.state.pageExtractionCalls),[1,1,1,1,1],"successful page reads survive the retry");
    mock.state.verificationGate=null;
    mock.state.concurrency=null;mock.state.pageQuestionCount=1;
    mock.state.multiPage=false;

    // Teacher marks still decide the verdict; incorrect and partial work receives a reference without being re-judged.
    mock.state.teacherMarked="merged";mock.state.referenceNumbers=[];mock.state.gradedNumbers=[];
    const marked=await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:{studentId:studentOneId,title:"老师已批改的练习",outputs:{wrongBook:true,report:false,profile:false}}});
    const markedId=marked.payload.submission.id;
    await submitPages(base,teacherOne,markedId,[await uploadPage(base,teacherOne,markedId,bytes)]);
    const markedResult=await waitForSubmission(base,teacherOne,markedId,["published"],worker);
    assert.deepEqual(markedResult.gradingItems.map(i=>[i.questionNumber,i.verdict,i.teacherMark,i.evidenceSummary]),[["1-3(1)","correct","correct","老师已打勾"],["1-3(2)","incorrect","incorrect","老师已打叉或圈出答案"],["1-4","incorrect",null,""]]);
    assert.deepEqual([mock.state.referenceNumbers.sort(),mock.state.gradedNumbers],[["1-3(2)","1-4"],["1-4"]],"teacher-marked mistakes receive answers without being re-judged");
    assert.ok(markedResult.gradingItems.find(i=>i.questionNumber==="1-3(2)").referenceVerified);
    assert.ok(mock.state.verdictOnlyPrompts>0);
    const unmarked=markedResult.gradingItems.find(i=>i.questionNumber==="1-4");
    assert.equal(unmarked.referenceEvidence,"已独立核验参考答案","a successful check with no explanation must not be labeled unverifiable");
    assert.deepEqual([unmarked.feedback,unmarked.stepAnalysis,unmarked.errorType,unmarked.standardAnswer,unmarked.standardAnalysis],["",[],"","5",""],"school homework keeps only the verdict and the final answer");
    assert.equal(markedResult.gradingSummary.archived,2,"the teacher's cross still files the sub-question after its answer is prepared");
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
    mock.state.teacherMarked="partial";mock.state.referenceNumbers=[];mock.state.gradedNumbers=[];
    const partialMarked=await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:{studentId:studentOneId,title:"半对题也有参考答案",outputs:{wrongBook:true,report:false,profile:false}}});
    const partialMarkedId=partialMarked.payload.submission.id;
    await submitPages(base,teacherOne,partialMarkedId,[await uploadPage(base,teacherOne,partialMarkedId,bytes)]);
    const partialMarkedResult=await waitForSubmission(base,teacherOne,partialMarkedId,["published"],worker);
    const half=partialMarkedResult.gradingItems.find(i=>i.questionNumber==="1-3(2)");
    assert.deepEqual([half.verdict,half.teacherMark,half.referenceVerified,half.standardAnswer],["partial","partial",true,"5"]);
    assert.equal(mock.state.gradedNumbers.includes("1-3(2)"),false,"an independent answer never changes the teacher's mark");
    // A historical / corrected mistake with no reference uses the same pending-item recovery.
    const formerlyCorrect=partialMarkedResult.gradingItems.find(i=>i.questionNumber==="1-3(1)");
    assert.equal(formerlyCorrect.standardAnswer,"");
    await jsonRequest(base,`/api/submissions/${partialMarkedId}`,{cookie:teacherOne,method:"PUT",body:{action:"correct",items:[{id:formerlyCorrect.id,verdict:"partial"}]}});
    mock.state.referenceNumbers=[];mock.state.gradedNumbers=[];
    assert.equal((await jsonRequest(base,`/api/submissions/${partialMarkedId}`,{cookie:teacherOne,method:"PUT",body:{action:"reprocess-pending"}})).response.status,200);
    const backfilled=await waitForSubmission(base,teacherOne,partialMarkedId,["published"],worker);
    const restored=backfilled.gradingItems.find(i=>i.id===formerlyCorrect.id);
    assert.deepEqual([restored.verdict,restored.referenceVerified,restored.standardAnswer],["partial",true,"5"],"backfilling preserves a teacher's corrected verdict");
    assert.deepEqual(mock.state.referenceNumbers,["1-3(1)"]);
    assert.deepEqual(mock.state.gradedNumbers,[]);
    mock.state.teacherMarked="";

    // 布置作业: a material handed out with its answers is graded against them, upload by upload; what has not come back is 未交, not wrong.
    const PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const sheetQuestion=(id,stem,answer,extra={})=>({id,type:"填空题",difficulty:"基础",stem,options:[],answer,analysis:"",source:"",categoryId:"",createdAt:0,updatedAt:0,...extra});
    const sheetBody={studentIds:[studentOneId],title:"两天计算打卡",groups:[{title:"第 1 天 · 热身",size:2},{title:"第 2 天 · 加深",size:2}],questions:[
      sheetQuestion("typeset-1","计算 $1+1$","2",{contentImages:[`data:image/png;base64,${PNG}`]}),
      sheetQuestion("typeset-2","计算 $2+2$","4",{analysis:"【点评】本题考查有理数的加法．"}),
      sheetQuestion("typeset-3","计算 $3\\times 3$","",{type:"解答题"}),
      sheetQuestion("typeset-4","计算 $4+4$","8"),
    ]};
    assert.equal((await jsonRequest(base,"/api/submissions",{cookie:teacherTwo,method:"POST",body:sheetBody})).response.status,404,"only the student's own teacher assigns to them");
    assert.equal((await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:{...sheetBody,groups:[{title:"第 1 天",size:3}]}})).response.status,400,"groups must account for every question");
    const assignedHomework=await jsonRequest(base,"/api/submissions",{cookie:teacherOne,method:"POST",body:sheetBody});
    assert.equal(assignedHomework.response.status,201,JSON.stringify(assignedHomework.payload));
    const firstUpload=assignedHomework.payload.assigned[0].id;
    assert.equal((await jsonRequest(base,`/api/submissions/${firstUpload}`,{cookie:teacherTwo})).response.status,404);
    let sheet=(await jsonRequest(base,`/api/submissions/${firstUpload}`,{cookie:teacherOne})).payload.submission;
    assert.equal(sheet.status,"draft");
    assert.deepEqual(sheet.assigned.questions.map(q=>[q.number,q.result]),[["D1-1",null],["D1-2",null],["D2-1",null],["D2-2",null]]);
    assert.deepEqual(sheet.assigned.groups.map(g=>g.title),["第 1 天 · 热身","第 2 天 · 加深"]);
    assert.deepEqual(sheet.outputs,{wrongBook:true,report:false,profile:true});
    assert.equal(sheet.processingProgress.identified,0,"nothing is identified before a page is read");
    // A picture that came with the material is stored for this teacher only.
    const sheetPicture=sheet.assigned.questions[0].question.contentImages[0];
    assert.match(sheetPicture,/^\/api\/assets\/[0-9a-f-]{36}$/);
    assert.equal((await fetch(base+sheetPicture,{headers:{Cookie:teacherOne}})).status,200);
    assert.equal((await fetch(base+sheetPicture,{headers:{Cookie:teacherTwo}})).status,404);
    const sheetRows=d1Rows(stateDir,"SELECT question_number,reference_source,reference_verified,taxonomy_keys_json FROM assignment_questions WHERE assignment_id=? ORDER BY sort_order",[sheet.assignmentId]);
    assert.deepEqual(sheetRows.map(r=>[r.question_number,r.reference_source,r.reference_verified]),[["D1-1","provided",1],["D1-2","provided",1],["D2-1","unresolved",0],["D2-2","provided",1]]);
    assert.ok(JSON.parse(sheetRows[1].taxonomy_keys_json).length,"a question the library never saw is tagged from what its analysis says it tests");
    let listed=(await jsonRequest(base,`/api/students/${studentOneId}/homework`,{cookie:teacherOne})).payload.homework.find(h=>h.assigned);
    assert.deepEqual([listed.title,listed.total,listed.done,listed.latest.status],["两天计算打卡",4,0,"draft"]);
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/homework`,{cookie:teacherTwo})).response.status,404);

    // The first upload brings day 1 back; the page also shows a stray question that is not on the sheet.
    mock.state.referenceNumbers=[];mock.state.gradedNumbers=[];
    mock.state.assignedPage=[{question_number:"D1-1",student_answer:"2"},{question_number:"1-2",student_answer:"5"},{question_number:"9",student_answer:"7"}];
    mock.state.assignedAnswers={"D1-1":"2","D1-2":"5"};mock.state.assignedVerdicts={"D1-1":"correct","D1-2":"incorrect"};
    await submitPages(base,teacherOne,firstUpload,[await uploadPage(base,teacherOne,firstUpload,bytes)]);
    sheet=await waitForSubmission(base,teacherOne,firstUpload,["published"],worker);
    assert.match(mock.state.assignedPrompts.at(-1),/D2-1｜第 2 天 第 1 题｜解答题｜计算 \$3\\times 3\$/);
    assert.deepEqual(sheet.gradingItems.map(i=>[i.questionNumber,i.verdict]),[["D1-1","correct"],["D1-2","incorrect"]],"a stray question is left out and 1-2 is read as D1-2");
    assert.deepEqual(mock.state.referenceNumbers,[],"answers handed out with the sheet are not solved again");
    assert.deepEqual(sheet.assigned.questions.map(q=>q.result?.verdict??null),["correct","incorrect",null,null]);
    assert.equal(sheet.gradingItems.find(i=>i.questionNumber==="D1-1").stem,"计算 $1+1$","the assigned stem stays as it was handed out");
    const sheetWrong=(await jsonRequest(base,`/api/students/${studentOneId}/wrong-questions`,{cookie:teacherOne})).payload.entries.filter(e=>e.assignmentId===sheet.assignmentId);
    assert.deepEqual(sheetWrong.map(e=>[e.question.stem,e.question.analysis]),[["计算 $2+2$","【点评】本题考查有理数的加法．"]],"the wrong book keeps the question as it was handed out");
    assert.ok(d1Rows(stateDir,"SELECT COUNT(*) AS count FROM student_capability_evidence WHERE submission_id=? AND dimension='knowledge'",[firstUpload])[0].count>0,"an assigned homework feeds the knowledge profile");
    listed=(await jsonRequest(base,`/api/students/${studentOneId}/homework`,{cookie:teacherOne})).payload.homework.find(h=>h.assigned);
    assert.deepEqual([listed.total,listed.done,listed.correct,listed.incorrect],[4,2,1,1]);

    // The next upload brings day 2: the question handed out without an answer is solved and checked first.
    const nextUpload=(await jsonRequest(base,`/api/submissions/${firstUpload}`,{cookie:teacherOne,method:"PUT",body:{action:"new-version"}})).payload.submission;
    assert.equal(nextUpload.version,2);assert.equal(nextUpload.status,"draft");
    mock.state.referenceNumbers=[];mock.state.gradedNumbers=[];
    mock.state.assignedPage=[{question_number:"D2-1",student_answer:"9"},{question_number:"第2天第2题",student_answer:"8"}];
    mock.state.assignedAnswers={"D2-1":"9","D2-2":"8"};mock.state.assignedVerdicts={"D2-1":"correct","D2-2":"correct"};
    await submitPages(base,teacherOne,nextUpload.id,[await uploadPage(base,teacherOne,nextUpload.id,bytes)]);
    sheet=await waitForSubmission(base,teacherOne,nextUpload.id,["published"],worker);
    assert.deepEqual(mock.state.referenceNumbers,["D2-1"]);
    assert.deepEqual(sheet.gradingItems.map(i=>i.questionNumber),["D2-1","D2-2"]);
    assert.deepEqual(sheet.assigned.questions.map(q=>[q.result?.verdict,q.result?.submissionId===firstUpload]),[["correct",true],["incorrect",true],["correct",false],["correct",false]],"each question keeps its result from the upload that found it");
    assert.deepEqual(sheet.assigned.uploads.map(u=>[u.version,u.status]),[[1,"published"],[2,"published"]]);
    listed=(await jsonRequest(base,`/api/students/${studentOneId}/homework`,{cookie:teacherOne})).payload.homework.find(h=>h.assigned);
    assert.deepEqual([listed.done,listed.correct,listed.incorrect,listed.latest.version],[4,3,1,2]);
    mock.state.assignedPage=[];mock.state.assignedAnswers={};mock.state.assignedVerdicts={};

    // 定档: graded knowledge from the assigned homework, and the teacher's lesson feedback with the abilities read from it.
    let profile=(await jsonRequest(base,`/api/students/${studentOneId}/profile`,{cookie:teacherOne})).payload.profile;
    assert.ok(profile.knowledge.some(item=>item.level==="domain"),"knowledge tallies carry their place in the graph");
    assert.ok(profile.types.some(item=>item.type==="填空题"&&item.correct>=2),"question types count only the work let into the profile");
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/profile`,{cookie:teacherTwo})).response.status,404);
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/observations`,{cookie:teacherTwo,method:"POST",body:{text:"越权"}})).response.status,404);
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/observations`,{cookie:teacherOne,method:"POST",body:{text:"  "}})).response.status,400);
    const lesson=await jsonRequest(base,`/api/students/${studentOneId}/observations`,{cookie:teacherOne,method:"POST",body:{text:"今天讲去括号，他计算还是粗心，丢负号。不过逆向思维不错。",observedAt:Date.now()-86_400_000}});
    assert.equal(lesson.response.status,201,JSON.stringify(lesson.payload));
    assert.equal(lesson.payload.notice,"");
    assert.deepEqual(lesson.payload.observation.abilities.map(note=>[note.key,note.polarity]),[["careless","weakness"],["thinking-reverse","strength"]],"a judgement that quotes nothing the teacher said is dropped");
    assert.deepEqual(lesson.payload.observation.keywords,["丢负号"]);
    assert.ok(lesson.payload.observation.extractedAt);
    assert.match(mock.state.observationPrompts.at(-1),/thinking-transform（思维能力 · 转化）/);
    const lessonId=lesson.payload.observation.id;
    // The teacher removes a judgement; a failed reading of new words keeps the words and clears the old reading.
    const trimmed=await jsonRequest(base,`/api/students/${studentOneId}/observations/${lessonId}`,{cookie:teacherOne,method:"PUT",body:{abilities:[lesson.payload.observation.abilities[1]]}});
    assert.deepEqual(trimmed.payload.observation.abilities.map(note=>note.key),["thinking-reverse"]);
    mock.state.failObservation=true;
    const reworded=await jsonRequest(base,`/api/students/${studentOneId}/observations/${lessonId}`,{cookie:teacherOne,method:"PUT",body:{text:"今天状态很好。"}});
    assert.equal(reworded.response.status,200);assert.ok(reworded.payload.notice);
    assert.deepEqual([reworded.payload.observation.text,reworded.payload.observation.abilities,reworded.payload.observation.extractedAt],["今天状态很好。",[],null]);
    mock.state.failObservation=false;
    profile=(await jsonRequest(base,`/api/students/${studentOneId}/profile?since=${Date.now()-3_600_000}`,{cookie:teacherOne})).payload.profile;
    assert.equal(profile.observations.length,0,"a lesson before the period is left out");
    profile=(await jsonRequest(base,`/api/students/${studentOneId}/profile`,{cookie:teacherOne})).payload.profile;
    assert.deepEqual(profile.observations.map(item=>item.id),[lessonId]);
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/observations/${lessonId}`,{cookie:teacherTwo,method:"DELETE",body:{}})).response.status,404);
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/observations/${lessonId}`,{cookie:teacherOne,method:"DELETE",body:{}})).response.status,200);
    assert.equal((await jsonRequest(base,`/api/students/${studentOneId}/profile`,{cookie:teacherOne})).payload.profile.observations.length,0);

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
