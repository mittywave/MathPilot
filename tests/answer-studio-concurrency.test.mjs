import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Execute the actual TS modules and their real pure dependencies, without
// requiring a web build, API key, esbuild or a paid model request.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function loader(overrides = {}) {
  const cache = new Map();
  function load(file) {
    const path = resolve(root, file);
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), {
      fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const localRequire = name => {
      if (name in overrides) return overrides[name];
      if (name.startsWith('.') && !/\.[cm]js$/.test(name)) return load(resolve(dirname(path), name + '.ts'));
      return createRequire(path)(name);
    };
    // Only checked-in repository source is compiled here, never model output.
    new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
    return module.exports;
  }
  return load;
}
const load = loader();
const { runStudioWindow, studioConcurrencyState, studioConcurrency, studioRetryAfter, StudioRequestError,
  studioApi, studioUpstreamFailure, studioCaughtFailure } = load('lib/answer-studio-concurrency.ts');
const { transcribeStudio } = load('lib/answer-studio-pipeline.ts');
const { emptyStudioDraft } = load('lib/answer-studio.ts');
const { studioTextReady } = load('lib/answer-studio-output.ts');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function clock() {
  let time = 0; const sleeps = [];
  return { now: () => time, random: () => 0, sleep: async ms => { sleeps.push(ms); time += ms; }, sleeps };
}
const box = { x: 0, y: 0, width: 1000, height: 1000 };
function page(n, role = 'answer') { return { id: `${role}-${n}`, role, name: role + '.pdf', page: n,
  image: 'data:image/png;base64,AA==', hash: `${role}-${n}`, selected: true }; }
function record(p, patch = {}) { return { id: `${p.id}:0`, lesson: 'Lesson', section: 'Examples', number: String(p.page),
  stem: `Question ${p.page}`, analysis: p.role === 'answer' ? `Steps ${p.page}` : '', source: { pageId: p.id, box },
  diagramBoxes: [], warnings: [], continuation: false, ...patch }; }
function draft(count = 9) { return { ...emptyStudioDraft(), inputMode: 'answers', title: 'Lesson', pages: Array.from({ length: count }, (_, i) => page(i + 1)) }; }
function services(patch = {}) {
  const saved = [], messages = [];
  return { saved, messages, progress: text => messages.push(text), checkpoint: async value => saved.push(structuredClone(value)),
    recognize: async p => [record(p)], crop: async image => ({ image, width: 100, height: 100 }),
    drawings: async () => ({ disposition: 'none', diagrams: [], warnings: [] }), ...patch };
}

test('concurrency defaults and limits reject invalid values', () => {
  for (const value of [undefined, null, 0, -2, NaN, 1.5, '6']) assert.equal(studioConcurrency(value), 4);
  assert.equal(studioConcurrency(100), 6);
  assert.equal(studioConcurrency(100, 2, 2), 2);
  assert.equal(studioConcurrency(1), 1);
});
test('window limits active requests and retains input order on reverse completion', async () => {
  let active = 0, max = 0;
  const out = await runStudioWindow([0,1,2,3,4,5,6,7], async n => {
    max = Math.max(max, ++active); await delay(10 - n); active--; return n;
  }, studioConcurrencyState(4));
  assert.equal(max, 4); assert.equal(active, 0);
  assert.deepEqual(out.map(r => r.value), [0,1,2,3,4,5,6,7]);
});
test('429 backs off, honors Retry-After, halves concurrency and retries only failed work', async () => {
  const state = studioConcurrencyState(4), time = clock(), calls = [0,0,0,0], notices = [];
  const out = await runStudioWindow([0,1,2,3], async n => {
    if (++calls[n] === 1 && n === 2) throw new StudioRequestError('limited', 429, 5000);
    return n;
  }, state, n => notices.push(n), time);
  assert.deepEqual(calls, [1,1,2,1]); assert.equal(state.limit, 2);
  assert.deepEqual(time.sleeps, [5000]); assert.equal(notices.length, 1);
  assert.ok(out.every(r => r.status === 'fulfilled'));
});
test('persistent 503 stops after three attempts, not an infinite loop', async () => {
  let calls = 0; const time = clock(), state = studioConcurrencyState(4);
  const out = await runStudioWindow([1], async () => { calls++; throw new StudioRequestError('busy', 503); }, state, () => {}, time);
  assert.equal(calls, 3); assert.equal(out[0].status, 'rejected'); assert.equal(state.limit, 1);
  assert.deepEqual(time.sleeps, [1000,2000]);
});
test('long Retry-After stops for manual continuation instead of retrying too early', async () => {
  let calls = 0; const time = clock();
  const out = await runStudioWindow([1], async () => { calls++; throw new StudioRequestError('quota',429,120000); }, studioConcurrencyState(4), () => {}, time);
  assert.equal(calls, 1); assert.equal(out[0].status, 'rejected'); assert.deepEqual(time.sleeps, []);
});
test('permanent, authentication and invalid-output errors are never retried', async () => {
  for (const error of [new Error('schema'), new StudioRequestError('key',401), new StudioRequestError('invalid',502,0,false)]) {
    let calls = 0;
    await runStudioWindow([1], async () => { calls++; throw error; }, studioConcurrencyState(4), () => {}, clock());
    assert.equal(calls, 1);
  }
});
test('a failed worker never leaves unresolved background tasks after return', async () => {
  let settled = false;
  const out = await runStudioWindow([1,2], async n => { if(n === 1) throw new Error('bad'); await delay(5); settled = true; return n; }, studioConcurrencyState(4));
  assert.equal(settled,true); assert.deepEqual(out.map(r=>r.status), ['rejected','fulfilled']);
});
test('Retry-After supports seconds, HTTP dates and rejects malformed input', () => {
  assert.equal(studioRetryAfter('2'), 2000);
  assert.equal(studioRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2015-10-21T07:27:57Z')), 3000);
  for(const value of [null,'','garbage','-4','Infinity']) assert.equal(studioRetryAfter(value),0);
});
test('pipeline reaches four active requests; records and checkpoints stay ordered', async () => {
  let active = 0, max = 0, writing = 0, maxWriting = 0, calls = 0;
  const input = draft(), original = structuredClone(input), s = services();
  s.recognize = async p => { calls++; max = Math.max(max, ++active); await delay(11-p.page); active--; return [record(p)]; };
  s.checkpoint = async value => { maxWriting=Math.max(maxWriting,++writing); await delay(1); s.saved.push(structuredClone(value)); writing--; };
  const result = await transcribeStudio(input,s,{drawings:false});
  assert.equal(max,4); assert.equal(maxWriting,1); assert.equal(calls,9); assert.deepEqual(input,original);
  assert.deepEqual(result.questions.map(q=>q.number), ['1','2','3','4','5','6','7','8','9']);
  assert.ok(studioTextReady(result)); assert.equal(result.pendingTranscriptions,undefined);
  for(const snapshot of s.saved) {
    const states=snapshot.pages.map(p=>!!p.processed); const firstFalse=states.indexOf(false);
    if(firstFalse>=0) assert.ok(states.slice(firstFalse).every(v=>!v));
  }
});
test('one-lane setting retains sequential context and does not mark requests concurrent', async () => {
  let active=0,max=0; const seen=[],s=services();
  s.recognize=async(p,context,options)=>{max=Math.max(max,++active);seen.push({p,context,options});await delay(1);active--;return [record(p)];};
  await transcribeStudio(draft(5),s,{drawings:false,textConcurrency:1});
  assert.equal(max,1); assert.ok(seen.every(x=>!x.options.concurrent)); assert.match(seen[2].context,/Steps 2/);
});
test('originals finish before answers even with interleaved input pages; repeated exports do not duplicate tables', async () => {
  const input={...draft(0),inputMode:'paired',pages:[page(1),page(1,'question'),page(2),page(2,'question'),page(3,'question'),page(3)]};
  const s=services(),calls=[]; let originals=0;
  s.recognize=async p=>{calls.push(p.role);if(p.role==='answer')assert.equal(originals,3);await delay(1);if(p.role==='question')originals++;return [record(p,{tables:[{rows:[[p.role]],warnings:[]}]})];};
  const result=await transcribeStudio(input,s,{drawings:false});
  assert.deepEqual(calls,['question','question','question','answer','answer','answer']);
  assert.equal(result.questions.length,3);assert.ok(result.questions.every(q=>q.answerIds.length===1&&q.tables.length===2));
  const again=await transcribeStudio(result,services({recognize:async()=>{throw new Error('must not recognize again');}}),{drawings:false});
  assert.equal(again.questions.length,3);assert.ok(again.questions.every(q=>q.tables.length===2));
});
test('a continuation inside a parallel window is re-recognized with its immediate predecessor before merge', async () => {
  const s=services(),seen=[];
  s.recognize=async(p,context,options)=>{
    seen.push({page:p.page,context,concurrent:options.concurrent});
    if(p.page===3) return [record(p,{number:options.concurrent?'1':'2',stem:'',continuation:true,analysis:'continuation of 2'})];
    return [record(p)];
  };
  const result=await transcribeStudio(draft(5),s,{drawings:false});
  const review=seen.filter(x=>x.page===3);assert.equal(review.length,2);assert.equal(review[1].concurrent,false);assert.match(review[1].context,/Steps 2/);
  const q=result.questions.find(q=>q.number==='2');assert.equal(q.analysis,'Steps 2\ncontinuation of 2');assert.equal(q.answerIds.length,2);
  assert.equal(result.questions.find(q=>q.number==='1').analysis,'Steps 1');assert.ok(studioTextReady(result));
});
test('failure retains later successes in a durable cache and resume does not re-request them', async () => {
  const s=services(),calls=[];
  s.recognize=async p=>{calls.push(p.page);if(p.page===2)throw new StudioRequestError('bad input',400);await delay(1);return [record(p)];};
  await assert.rejects(transcribeStudio(draft(5),s,{drawings:false}),/2/);
  const checkpoint=s.saved.at(-1);
  assert.deepEqual(checkpoint.pages.map(p=>!!p.processed),[true,false,false,false,false]);
  assert.deepEqual(Object.keys(checkpoint.pendingTranscriptions),['answer-3','answer-4','answer-5']);
  const retried=[],resume=services({recognize:async p=>{retried.push(p.page);return [record(p)];}});
  const result=await transcribeStudio(checkpoint,resume,{drawings:false});
  assert.deepEqual(retried,[2]);assert.deepEqual(result.questions.map(q=>q.number),['1','2','3','4','5']);assert.ok(studioTextReady(result));
});
test('changed source hash invalidates a cached page result', async () => {
  const input=draft(1);input.pendingTranscriptions={'answer-1':{hash:'old',context:'',concurrent:false,records:[record(input.pages[0],{analysis:'old'})]}};
  let calls=0;const result=await transcribeStudio(input,services({recognize:async p=>{calls++;return [record(p)];}}),{drawings:false});
  assert.equal(calls,1);assert.equal(result.questions[0].analysis,'Steps 1');
});
test('a checkpoint failure prevents further windows and does not mark the caller draft processed', async () => {
  const input=draft(8);let calls=0;
  await assert.rejects(transcribeStudio(input,services({recognize:async p=>{calls++;return [record(p)];},checkpoint:async()=>{throw new Error('disk full');}}),{drawings:false}),/disk full/);
  assert.equal(calls,1);assert.ok(input.pages.every(p=>!p.processed));
});
test('drawing workers overlap at two, atomically commit and retain all text', async () => {
  const text=await transcribeStudio(draft(5),services(),{drawings:false});
  let active=0,max=0;
  const s=services({recognize:async()=>{throw new Error('unexpected text request');},drawings:async q=>{
    max=Math.max(max,++active);await delay(8-Number(q.number));active--;return {disposition:'none',diagrams:[],warnings:[]};
  }});
  const result=await transcribeStudio(text,s,{drawings:true});
  assert.equal(max,2);assert.deepEqual(result.questions.map(q=>q.analysis),text.questions.map(q=>q.analysis));assert.ok(result.questions.every(q=>q.drawingsChecked));
  assert.ok(text.questions.every(q=>!q.drawingsChecked));
});
test('drawing retries cannot duplicate geometry; already completed drawings are reused', async () => {
  const text=await transcribeStudio(draft(3),services(),{drawings:false});
  const calls={};const shape={id:'line',kind:'line',x:0,y:0,width:10,height:10,color:'#C00000',weight:2,dash:false,text:'',points:[]};
  const s=services({drawings:async q=>{calls[q.number]=(calls[q.number]||0)+1;if(q.number==='1'&&calls['1']===1)throw new StudioRequestError('busy',503);return {disposition:'solution',diagrams:[{baseIndex:-1,caption:q.number,shapes:[shape],warnings:[]}],warnings:[]};}});
  const result=await transcribeStudio(text,s,{drawings:true,retryRuntime:clock()});
  assert.equal(calls['1'],2);assert.ok(result.questions.every(q=>q.diagrams.length===1&&q.diagrams[0].shapes.length===1));
  await transcribeStudio(result,services({drawings:async()=>{throw new Error('cached drawing was rerun');}}),{drawings:true});
});
test('failed drawing remains retryable and other questions survive unchanged', async () => {
  const text=await transcribeStudio(draft(3),services(),{drawings:false});
  const result=await transcribeStudio(text,services({drawings:async q=>{if(q.number==='2')throw new Error('invalid shapes');return {disposition:'none',diagrams:[],warnings:[]};}}),{drawings:true});
  assert.deepEqual(result.questions.map(q=>q.drawingsChecked),[true,false,true]);assert.equal(result.questions[1].analysis,'Steps 2');
  const calls=[];const retried=await transcribeStudio(result,services({drawings:async q=>{calls.push(q.number);return {disposition:'none',diagrams:[],warnings:[]};}}),{drawings:true});
  assert.deepEqual(calls,['2']);assert.ok(retried.questions.every(q=>q.drawingsChecked));
});
test('text-only output never calls drawing or crop services', async () => {
  await transcribeStudio(draft(4),services({drawings:async()=>{throw new Error('must not draw');},crop:async()=>{throw new Error('must not crop');}}),{drawings:false});
});
test('Studio HTTP response preserves upstream 429 and Retry-After, while missing configuration and schema errors are non-retryable', async () => {
  const response=studioUpstreamFailure({status:429,error:'limited',retryAfter:'5'},'fallback');
  assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'5');assert.equal((await response.json()).retryable,true);
  const schema=studioUpstreamFailure({status:200},'empty output');assert.equal((await schema.json()).retryable,false);
  const error=studioCaughtFailure(new SyntaxError('bad JSON'),'error');assert.equal((await error.json()).retryable,false);
  const network=studioCaughtFailure(new TypeError('fetch failed'),'error');assert.equal((await network.json()).retryable,true);
});
test('browser HTTP client keeps status and retry advice instead of throwing a plain Error', async t => {
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:'limited'},{status:429,headers:{'retry-after':'3'}}));
  await assert.rejects(studioApi('/test',{}),e=>e instanceof StudioRequestError&&e.status===429&&e.retryAfterMs===3000&&e.retryable);
  globalThis.fetch=async()=>Response.json({error:'not configured',retryable:false},{status:503});
  await assert.rejects(studioApi('/test',{}),e=>e instanceof StudioRequestError&&!e.retryable);
});
test('new speed selector does not clear saved results or change the existing Word controls', () => {
  const page=readFileSync(resolve(root,'app/tools/answer-studio/page.tsx'),'utf8');
  assert.match(page,/id="studio-text-concurrency"/);assert.match(page,/title:title.trim\(\),textConcurrency\}/);
  assert.match(page,/onChange=\{e=>setTextConcurrency\(Number\(e.target.value\)\)\}/);
  assert.match(page,/'\u751f\u6210 Word'/);assert.match(page,/includeTranscriptionWarnings/);
});

test('Gemini adapter retains status and Retry-After even for a non-JSON gateway error', async t => {
  const { callAntigravityGemini }=load('lib/server/antigravity-gemini.ts');
  t.mock.method(globalThis,'fetch',async()=>new Response('gateway unavailable',{status:503,headers:{'retry-after':'7'}}));
  const result=await callAntigravityGemini('https://example.invalid','test-key','test-model','test',[],{});
  assert.equal(result.status,503);assert.equal(result.retryAfter,'7');assert.equal(result.text,undefined);
});
// These two cases explicitly cover pre-0015 legacy runtime; V2 is tested against real bindings separately.
test('Studio auto mode does not turn a 429 into an immediate second-protocol request', async t => {
  const oldMode=process.env.OPENAI_API_MODE;
  t.after(()=>{if(oldMode===undefined)delete process.env.OPENAI_API_MODE;else process.env.OPENAI_API_MODE=oldMode;});
  process.env.OPENAI_API_MODE='auto';let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({error:{message:'limited'}},{status:429,headers:{'retry-after':'9'}});});
  const {callRecognitionModel}=loader({'./ai/provider-repository':{hasV2Schema:async()=>false}, './ai/engine':{callV2:()=>{throw new Error('Legacy regression must not enter V2');}}, './recognition-model-rules.mjs':{recognitionReasoningEffort:()=> 'low'}, './ai-provider':{resolveAiRuntime:async()=>({source:'environment',providerName:'test',apiKey:'test-key',baseUrl:'https://test.invalid/v1',model:'test-model',wireApi:process.env.OPENAI_API_MODE})}})('lib/server/recognition-model.ts');
  const result=await callRecognitionModel({apiKey:'test-key',prompt:'test',image:'data:image/png;base64,AA==',schema:{},schemaName:'teacher_answer_transcription'});
  assert.equal(calls,1);assert.equal(result.status,429);assert.equal(result.retryAfter,'9');
});
test('Chat Completions non-JSON HTTP errors preserve retry metadata', async t => {
  const oldMode=process.env.OPENAI_API_MODE;
  t.after(()=>{if(oldMode===undefined)delete process.env.OPENAI_API_MODE;else process.env.OPENAI_API_MODE=oldMode;});
  process.env.OPENAI_API_MODE='chat_completions';
  t.mock.method(globalThis,'fetch',async()=>new Response('unavailable',{status:502,headers:{'retry-after':'4'}}));
  const {callRecognitionModel}=loader({'./ai/provider-repository':{hasV2Schema:async()=>false}, './ai/engine':{callV2:()=>{throw new Error('Legacy regression must not enter V2');}}, './recognition-model-rules.mjs':{recognitionReasoningEffort:()=> 'low'}, './ai-provider':{resolveAiRuntime:async()=>({source:'environment',providerName:'test',apiKey:'test-key',baseUrl:'https://test.invalid/v1',model:'test-model',wireApi:process.env.OPENAI_API_MODE})}})('lib/server/recognition-model.ts');
  const result=await callRecognitionModel({apiKey:'test-key',prompt:'test',image:'data:image/png;base64,AA==',schema:{},schemaName:'teacher_answer_transcription'});
  assert.equal(result.status,502);assert.equal(result.retryAfter,'4');
});
test('actual Studio routes expose transient HTTP codes, reject malformed output without retry, and retain authentication', async t => {
  const oldKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';
  t.after(()=>{if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;});
  let upstream={status:429,error:'limited',retryAfter:'6'},denied=false;
  const routed=loader({
    '../../../../lib/server/auth':{requireSameOrigin:()=>{},requireUser:async()=>{if(denied)throw new Response('Forbidden',{status:403});}},
    '../../../../lib/server/recognition-model':{callRecognitionModel:async()=>upstream,parseRecognitionModelText:JSON.parse},
    '../../../../lib/answer-studio-contract':{normalizeStudioRecords:x=>x.records,studioRecognitionPrompt:()=> 'TRANSCRIBE',studioRecognitionSchema:{},normalizeStudioDrawings:x=>x,studioDrawingSchema:{}},
  });
  // Page recognition now runs inside the server job (lib/server/answer-studio-jobs.ts).
  for(const kind of ['drawings']) {
    const {POST}=routed(`app/api/answer-studio/${kind}/route.ts`);
    const data={image:'data:image/png;base64,AA==',stem:'x',analysis:'y',bases:[]};
    const request=()=>new Request('http://localhost/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    upstream={status:429,error:'limited',retryAfter:'6'};
    const limited=await POST(request());assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'6');assert.equal((await limited.json()).retryable,true);
    upstream={status:200,text:'not JSON'};
    const malformed=await POST(request());assert.equal((await malformed.json()).retryable,false);
    denied=true;assert.equal((await POST(request())).status,403);denied=false;
    delete process.env.OPENAI_API_KEY;
    // Availability is now decided by the unified runtime, not a route-level environment guard.
    upstream={status:503,error:'尚未配置智能识别',retryAfter:null,terminal:true};
    const missing=await POST(request());assert.equal(missing.status,503);assert.equal((await missing.json()).retryable,false);process.env.OPENAI_API_KEY='test-key';
  }
});
test('repeated drawing throttling stops new windows but saves successful peers', async () => {
  const text=await transcribeStudio(draft(5),services(),{drawings:false});
  const s=services(),calls=[];
  s.drawings=async q=>{calls.push(q.number);if(q.number==='1')throw new StudioRequestError('quota',429);return {disposition:'none',diagrams:[],warnings:[]};};
  await assert.rejects(transcribeStudio(text,s,{drawings:true,retryRuntime:clock()}),/quota/);
  assert.ok(calls.every(n=>['1','2'].includes(n)));
  const result=s.saved.at(-1);assert.equal(result.questions[1].drawingsChecked,true);assert.equal(result.questions[0].drawingsChecked,false);assert.equal(result.questions.length,5);
});
test('a failed continuation review keeps all cached results without committing wrong ownership', async () => {
  const s=services();
  s.recognize=async(p,context,options)=>{
    if(p.page===3&&!options.concurrent)throw new StudioRequestError('unavailable',503);
    return [record(p,p.page===3?{continuation:true,number:'2',stem:'',analysis:'continued'}:{})];
  };
  await assert.rejects(transcribeStudio(draft(5),s,{drawings:false,retryRuntime:clock()}),/unavailable/);
  const snap=s.saved.at(-1);assert.deepEqual(snap.pages.map(p=>!!p.processed),[true,true,false,false,false]);
  assert.deepEqual(Object.keys(snap.pendingTranscriptions),['answer-3','answer-4','answer-5']);
  assert.equal(snap.questions.find(q=>q.number==='2').analysis,'Steps 2');
});
