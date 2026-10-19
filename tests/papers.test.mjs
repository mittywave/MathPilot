import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { loadSource } from "./load-source.mjs";
const MIGRATIONS = new URL("../migrations/",import.meta.url);
async function migrate(sqlite, until = "9999") {
  for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith(".sql")).sort()) {
    if (name >= until) break;
    sqlite.exec(await readFile(new URL(name, MIGRATIONS), "utf8"));
  }
}

// Actual SQLite SQL and constraints behind the D1 method shape the server module uses.
function d1(sqlite) {
  return {
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value); return statement; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...args) }; },
        async run() { const result = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: result.changes } }; },
        execute() { const prepared = sqlite.prepare(sql); return { results: prepared.columns().length ? prepared.all(...args) : [], ...(!prepared.columns().length ? { meta: { changes: prepared.run(...args).changes } } : {}) }; },
      };
      return statement;
    },
    async batch(statements) { sqlite.exec("BEGIN"); try { const results = statements.map((statement) => statement.execute()); sqlite.exec("COMMIT"); return results; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } },
  };
}


async function fixture() {
  const sqlite=new DatabaseSync(":memory:");sqlite.exec("PRAGMA foreign_keys=ON");await migrate(sqlite);
  sqlite.exec("INSERT INTO users(id,email,password_hash,password_salt,password_iterations,role,created_at) VALUES('paper-teacher','paper@test','x','x',1,'admin',0)");
  const files=new Map(),env={DB:d1(sqlite),HOMEWORK_ASSETS:{async put(key,value){files.set(key,value);},async get(key){const value=files.get(key);return value===undefined?null:{json:async()=>JSON.parse(value),arrayBuffer:async()=>value,body:value};},async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])files.delete(key);},async list(){return{objects:[],truncated:false};}}};
  const api=await loadSource("lib/server/papers.ts",env),lib=await loadSource("lib/server/library.ts",env),rules=await loadSource("lib/papers.ts");
  const user={id:"paper-teacher",email:"paper@test",role:"admin"};
  function paper(id){sqlite.prepare("INSERT INTO studio_jobs(id,owner_user_id,title,kind,status,run_id,created_at,updated_at) VALUES(?,?,'测试试卷','import','running','run-1',1,1)").run('job-'+id,user.id);sqlite.prepare("INSERT INTO exam_papers(id,folder_id,title,file_name,source_key,source_type,source_hash,job_id,created_by,created_at,updated_at) VALUES(?,'paper-g7a','测试试卷','test.docx',?,'application/octet-stream',?,?,?,1,1)").run(id,'papers/'+id+'/source','hash-'+id,'job-'+id,user.id);}
  const count=()=>sqlite.prepare('SELECT count(*) AS n FROM library_questions_v2 WHERE deleted_at IS NULL').get().n;
  return{sqlite,api,lib,rules,user,paper,count,files,env};
}
const question=(stem="计算 $2+3$ 的值。",extra={})=>({id:"",categoryId:"",type:"填空题",difficulty:"基础",stem,options:[],answer:"5",analysis:"",source:"",createdAt:0,updatedAt:0,...extra});
function draft(questions){return{title:"2025 深圳七年级期末试卷",metadata:{kind:"school",year:"2025",school:"深圳中学",district:"深圳",grade:"七年级",term:"上",examType:"期末",moduleId:""},issues:[],classified:true,questions:questions.map((q,i)=>({number:String(i+1),section:"一、填空题",page:1,question:q,categoryPath:["有理数","有理数的加减"],warnings:[]}))};}

test("paper folders preserve descendants, reject cycles and only delete empty folders",async()=>{
  const f=await fixture();try{let folders=await f.api.readPaperFolders();assert.equal(folders.length,12);await f.api.savePaperFolder({name:"自定义",parentId:"paper-g7a"});folders=await f.api.readPaperFolders();const added=folders.find(x=>x.name==="自定义");await assert.rejects(f.api.savePaperFolder({id:"paper-school",name:"期中期末与统考",parentId:added.id}),e=>e.status===400);await f.api.savePaperFolder({id:added.id,name:"改名",parentId:"paper-mock"});assert.equal((await f.api.readPaperFolders()).find(x=>x.id===added.id).parentId,"paper-mock");f.paper("p1");await assert.rejects(f.api.deletePaperFolder(f.user,"paper-g7a"),e=>e.status===400);await assert.rejects(f.api.deletePaperFolder({...f.user,role:"member"},added.id),e=>e.status===403);await f.api.deletePaperFolder(f.user,added.id);assert.ok(!(await f.api.readPaperFolders()).some(x=>x.id===added.id));}finally{f.sqlite.close();}
});
test("whole paper commits ordered references and permanent IDs; repeats and concurrent papers reuse questions",async()=>{
 const f=await fixture();try{f.paper("p1");const d=draft([question(),question("计算 $3+4$ 的值。",{answer:"7"})]);await f.api.commitPaper("p1",d,f.user,"run-1");let result=await f.api.readPaper("p1",f.user);assert.equal(result.status,"done");assert.deepEqual(result.items.map(i=>i.number),["1","2"]);assert.ok(result.items.every(i=>/^\d{4,}$/.test(i.question.code)));assert.equal(f.count(),2);await f.api.commitPaper("p1",d,f.user,"run-1");assert.equal(f.count(),2);
 f.paper("p2");f.paper("p3");await Promise.all([f.api.commitPaper("p2",{...d,title:"另一个来源"},f.user,"run-1"),f.api.commitPaper("p3",d,f.user,"run-1")]);assert.equal(f.count(),2);const again=await f.api.readPaper("p2",f.user);assert.deepEqual(again.items.map(i=>i.questionId),result.items.map(i=>i.questionId));assert.equal((await f.api.readPaperFolders()).find(x=>x.id==="paper-school").count,3);
 }finally{f.sqlite.close();}
});
test("a failed or cancelled whole-paper transaction leaves no questions or auto-created directories",async()=>{
 const f=await fixture();try{f.paper("cancelled");const before=f.sqlite.prepare("SELECT count(*) AS n FROM library_modules_v2").get().n;await assert.rejects(f.api.commitPaper("cancelled",draft([question()]),f.user,"stale-run"),/NOT NULL/);assert.equal(f.count(),0);assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM library_modules_v2").get().n,before);assert.equal((await f.api.readPaper("cancelled",f.user)).items.length,0);
 f.paper("partial");const bad=draft([question(),question("")]);await assert.rejects(f.api.commitPaper("partial",bad,f.user,"run-1"),/缺少题干/);assert.equal(f.count(),0);
 }finally{f.sqlite.close();}
});
test("strict identity keeps different figures and mathematical grouping separate",async()=>{
 const f=await fixture();try{f.paper("figures");const one=question("如图，求角 A 的度数。",{answer:"",contentImages:["data:image/png;base64,YQ=="]}),two={...one,contentImages:["data:image/png;base64,Yg=="]};await f.api.commitPaper("figures",draft([one,two]),f.user,"run-1");assert.equal(f.count(),2);const hash=new Map();assert.notEqual(f.rules.paperQuestionIdentity(question("计算 $\\frac{1}{2x}$。"),hash),f.rules.paperQuestionIdentity(question("计算 $\\frac{1}{2}x$。"),hash));assert.notEqual(f.rules.paperQuestionIdentity(question("（至少选择两项）求结果。"),hash),f.rules.paperQuestionIdentity(question("求结果。"),hash));
 }finally{f.sqlite.close();}
});
test("shared edits appear in every paper and removing a paper never removes library questions",async()=>{
 const f=await fixture();try{f.paper("p1");await f.api.commitPaper("p1",draft([question()]),f.user,"run-1");const first=await f.api.readPaper("p1",f.user),q=first.items[0].question;await f.lib.updateScopedQuestion(q.id,{...q,analysis:"补充解析"},f.user);assert.equal((await f.api.readPaper("p1",f.user)).items[0].question.analysis,"补充解析");await f.lib.deleteScopedQuestion(q.id,f.user);assert.equal((await f.api.readPaper("p1",f.user)).items[0].question,null);await f.lib.restoreScopedQuestion(q.id,f.user);assert.equal((await f.api.readPaper("p1",f.user)).items[0].question.code,q.code);await f.api.deletePaper(f.user,"p1");assert.equal(f.count(),1);
 }finally{f.sqlite.close();}
});
test("answer conflicts block the whole import; missing answers can be supplemented",async()=>{
 const f=await fixture();try{f.paper("p1");await f.api.commitPaper("p1",draft([question(undefined,{answer:""})]),f.user,"run-1");f.paper("p2");await f.api.commitPaper("p2",draft([question()]),f.user,"run-1");assert.equal(f.count(),1);assert.equal((await f.api.readPaper("p1",f.user)).items[0].question.answer,"5");f.paper("p3");await assert.rejects(f.api.commitPaper("p3",draft([question(undefined,{answer:"6"}),question("新的另题",{answer:""})]),f.user,"run-1"),/答案冲突/);assert.equal(f.count(),1);
 }finally{f.sqlite.close();}
});

test("concurrent first imports use one identity and refuse conflicting concurrent supplements",async()=>{
 const f=await fixture();try{f.paper("a");f.paper("b");await Promise.all([f.api.commitPaper("a",draft([question()]),f.user,"run-1"),f.api.commitPaper("b",draft([question()]),f.user,"run-1")]);assert.equal(f.count(),1);
 const blank=question("求 $4+8$ 的值。",{answer:""});f.paper("blank");await f.api.commitPaper("blank",draft([blank]),f.user,"run-1");f.paper("c");f.paper("d");const outcomes=await Promise.allSettled([f.api.commitPaper("c",draft([{...blank,answer:"12"}]),f.user,"run-1"),f.api.commitPaper("d",draft([{...blank,answer:"13"}]),f.user,"run-1")]);assert.equal(outcomes.filter(o=>o.status==="fulfilled").length,1);assert.equal(f.count(),2);
 }finally{f.sqlite.close();}
});
test("reusing only existing questions does not create unused modules or classifications",async()=>{
 const f=await fixture();try{f.paper("a");await f.api.commitPaper("a",draft([question()]),f.user,"run-1");const before=f.sqlite.prepare("SELECT count(*) AS n FROM library_categories_v2").get().n;f.paper("b");const d=draft([question()]);d.metadata.kind="admission";d.questions[0].categoryPath=["另一个无须创建的目录"];await f.api.commitPaper("b",d,f.user,"run-1");assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM library_categories_v2").get().n,before);assert.equal(f.count(),1);
 }finally{f.sqlite.close();}
});
test("paper completeness rejects repeated numbers, gaps, missing stems and incomplete continuations",async()=>{
 const f=await fixture();try{let d=draft([question(),question()]);d.questions[1].number="1";assert.match(f.rules.paperDraftIssues(d).join(' '),/重复/);d.questions[1].number="3";assert.match(f.rules.paperDraftIssues(d).join(' '),/不连续/);d.questions[1].number="2";d.questions[1].incomplete=true;assert.match(f.rules.paperDraftIssues(d).join(' '),/跨页/);d.questions[1].incomplete=false;d.expectedCount=3;assert.match(f.rules.paperDraftIssues(d).join(' '),/原卷标注/);
 }finally{f.sqlite.close();}
});
test("page checkpoints join a continued question and pair the original numbered answer without publishing partial rows",async()=>{
 const f=await fixture();try{f.paper("pdf");const base={...question(),question_number:"1",section:"一、填空题",continuation:false,incomplete:true,tags:[],warnings:[],confidence:1,diagram_bbox:null,options_bbox:null};const source={version:1,fileName:"试卷.pdf",categories:[],notes:[],pages:[{id:"p1",page:1,name:"p1",hash:"1"},{id:"p2",page:2,name:"p2",hash:"2"}],results:{p1:{result:{title:"七年级试卷",expected_count:1,questions:[{...base,stem:"已知一个整数",answer:""}],answers:[]}},p2:{result:{title:"",expected_count:0,questions:[{...base,stem:"比 3 大 2，求该整数。",answer:"",continuation:true,incomplete:false}],answers:[{question_number:"1",section:"参考答案",answer:"5",analysis:"",continuation:false}]}}}};
 let failure;try{await f.api.runPaperImport("pdf","job-pdf","run-1",source,{signal:new AbortController().signal,touch:async()=>{},checkpoint:async()=>{},boundary:()=>{},image:async()=>new ArrayBuffer(0),recognize:async()=>{throw Error("cached pages must not be re-read");}});}catch(e){failure=e;}
 assert.ok(failure,"the fixture has no configured classifier");const kept=await f.api.readPaperDraft("pdf");assert.equal(kept.questions.length,1);assert.equal(kept.questions[0].question.stem,"已知一个整数\n比 3 大 2，求该整数。");assert.equal(kept.questions[0].question.answer,"5");assert.equal(kept.questions[0].incomplete,false);assert.equal(f.count(),0);
 }finally{f.sqlite.close();}
});

test("scanned answer sheets that repeat solved stems fill the originals instead of doubling the question count",async()=>{
 const f=await fixture();try{f.paper("scan");const q={...question(),question_number:"1",section:"",continuation:false,incomplete:false,tags:[],warnings:[],confidence:1,diagram_bbox:null,options_bbox:null};const source={version:1,fileName:"扫描试卷.pdf",categories:[],notes:[],pages:[{id:"p1",page:1,name:"p1",hash:"1"},{id:"p2",page:2,name:"p2",hash:"2"}],results:{p1:{result:{title:"七年级试卷",expected_count:1,questions:[{...q,answer:""}],answers:[]}},p2:{result:{title:"",expected_count:0,questions:[{...q,answer:"5",analysis:"原件中的解答过程。"}],answers:[]}}}};
 try{await f.api.runPaperImport("scan","job-scan","run-1",source,{signal:new AbortController().signal,touch:async()=>{},checkpoint:async()=>{},boundary:()=>{},image:async()=>new ArrayBuffer(0),recognize:async()=>{throw Error("must use saved pages");}});}catch{/* This fixture deliberately has no classification model. */}
 const kept=await f.api.readPaperDraft("scan");assert.equal(kept.questions.length,1);assert.equal(kept.questions[0].question.answer,"5");assert.equal(kept.questions[0].question.analysis,"原件中的解答过程。");assert.equal(f.count(),0);
 }finally{f.sqlite.close();}
});

test("source upload failures clean up unlinked jobs, and identical files reuse the existing upload",async()=>{
 const f=await fixture();try{
  const request=()=>new Request("http://local/api/papers?fileName=test.pdf&folder=paper-g7a",{method:"POST",body:"%PDF-test-source"});
  const put=f.env.HOMEWORK_ASSETS.put;f.env.HOMEWORK_ASSETS.put=async(key,value)=>{if(key.endsWith('/source'))throw Error("R2 write failed");return put(key,value);};
  await assert.rejects(f.api.createPaper(f.user,request()),/R2 write failed/);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM studio_jobs').get().n,0);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM exam_papers').get().n,0);
  f.env.HOMEWORK_ASSETS.put=put;const first=await f.api.createPaper(f.user,request()),again=await f.api.createPaper(f.user,request());assert.equal(first.paper.id,again.paper.id);assert.equal(again.existing,true);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM studio_jobs').get().n,1);
 }finally{f.sqlite.close();}
});

test("paper section metadata stays in the source document and never changes ordinary question import payloads",async()=>{
 const reader=await loadSource("lib/file-import.ts");const source={questionNumber:"1",section:"一、选择题",type:"单选题",stem:"原题",options:["1","2"],sourcePage:1,warnings:[],stemParagraphs:[],stemDocxXml:[],stemDocxAssets:{},optionsDocxXml:[],optionsDocxAssets:{},contentImages:[]};const pages=[{pageNumber:1,image:"",sourceQuestions:[source]}];const item=reader.structuredDocxQuestions(pages)[0];assert.ok(!("section" in item));assert.equal(pages[0].sourceQuestions[0].section,"一、选择题");assert.equal(item.questionNumber,"1");
});

test("another signed-in teacher can finish a shared paper upload without gaining access to the owner's private jobs",async()=>{
 const f=await fixture();try{
  f.sqlite.exec("INSERT INTO users(id,email,password_hash,password_salt,password_iterations,role,created_at) VALUES('colleague','colleague@test','x','x',1,'member',0)");
  const token='synthetic-paper-test-session';f.sqlite.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(Buffer.from(await f.lib.hashText(token),'hex').toString('base64'),'colleague',Date.now()+60000,Date.now());
  const created=await f.api.createPaper(f.user,new Request('https://fixture.test/api/papers?fileName=test.pdf&folder=paper-g7a',{method:'POST',body:'%PDF-upload-test'}));
  const body={page:{id:'page-1',page:1,name:'test.pdf',hash:'page-1'},image:'data:image/jpeg;base64,AQID',recognizeImage:'data:image/jpeg;base64,AQID'};
  const request=(session=true)=>new Request('https://fixture.test/api/papers/'+created.paper.id,{method:'POST',headers:{Origin:'https://fixture.test','Content-Type':'application/json',...(session?{Cookie:'zhiti_session='+token}:{})},body:JSON.stringify(body)});
  const route=await loadSource('app/api/papers/[id]/route.ts',f.env);let response=await route.POST(request(),{params:Promise.resolve({id:created.paper.id})});assert.equal(response.status,200);assert.equal((await response.json()).job.pageCount,1);
  response=await route.POST(request(false),{params:Promise.resolve({id:created.paper.id})});assert.equal(response.status,401);
  const privateRoute=await loadSource('app/api/answer-studio/jobs/[id]/pages/route.ts',f.env);response=await privateRoute.POST(request(),{params:Promise.resolve({id:created.paper.jobId})});assert.equal(response.status,404);
 }finally{f.sqlite.close();}
});
