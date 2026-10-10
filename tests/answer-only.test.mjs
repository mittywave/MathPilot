import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const result=await build({entryPoints:['lib/answer-studio.ts'],bundle:true,platform:'node',format:'esm',write:false});
const m=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const record=(id,section='例题',continuation=false)=>({id,lesson:'第一讲',section,number:'1',stem:'',analysis:'原文步骤'+id,source:{pageId:id,box:{x:0,y:0,width:100,height:100}},diagramBoxes:[],warnings:[],continuation});
test('answer-only records work without stems, preserve order and merge unambiguous continuations',()=>{
 const d={...m.emptyStudioDraft(),inputMode:'answers',answers:[record('a'),record('b','例题',true),record('c','练习')]};
 d.questions=m.attachAnswerOnlyRecords(d);
 assert.equal(d.questions.length,2);assert.deepEqual(d.questions[0].answerIds,['a','b']);
 assert.equal(d.questions[0].analysis,'原文步骤a\n原文步骤b');
 assert.deepEqual(m.attachAnswerOnlyRecords(d),d.questions);
 const q=d.questions[0];q.resolutions=Object.fromEntries(q.warnings.map(w=>[w,'对照原件确认']));
 assert.deepEqual(m.studioQuestionIssues(q),[]);
 assert.ok(m.studioQuestionIssues({...q,answerOnly:false}).includes('缺少题干'));
 assert.equal(m.reviseStudioQuestion({...q,reviewed:true},{analysis:'修改'}).reviewed,false);
});
test('ambiguous repeated numbers and orphan continuations remain explicit review items',()=>{
 const d={...m.emptyStudioDraft(),answers:[record('a'),record('b'),record('c','例题',true)]};
 const q=m.attachAnswerOnlyRecords(d);assert.equal(q.length,3);
 assert.ok(q[1].warnings.some(w=>w.includes('重复')));
 assert.ok(q[2].warnings.some(w=>w.includes('不明确')));
 assert.ok(m.studioQuestionIssues(q[2]).length>0);
});
test('answer-only backups retain mode and evidence but reset review on import',()=>{
 const d={...m.emptyStudioDraft(),inputMode:'answers',answers:[record('a')]};
 d.pages=[{id:'a',role:'answer',image:'data:image/png;base64,YQ=='}];
 d.questions=m.attachAnswerOnlyRecords(d);d.questions[0].reviewed=true;
 const restored=m.validateStudioDraft(JSON.parse(JSON.stringify(d)));
 assert.equal(restored.inputMode,'answers');assert.equal(restored.questions[0].answerOnly,true);
 assert.equal(restored.questions[0].reviewed,false);assert.deepEqual(restored.questions[0].answerIds,['a']);
 assert.throws(()=>m.validateStudioDraft({...d,inputMode:'unknown'}));
});
test('same-number alternative questions cannot be merged merely because AI says continuation',()=>{
 const a={...record('a'),stem:'已知三角形满足条件甲，判断形状。'};
 const b={...record('b','例题',true),stem:'已知三角形满足不同条件乙，求证等腰。'};
 const q=m.attachAnswerOnlyRecords({...m.emptyStudioDraft(),answers:[a,b]});
 assert.equal(q.length,2);assert.deepEqual(q[0].answerIds,['a']);
 assert.deepEqual(q[1].answerIds,['b']);assert.ok(q[1].warnings.some(w=>w.includes('不同版本')));
 const continued=m.attachAnswerOnlyRecords({...m.emptyStudioDraft(),answers:[a,{...b,stem:a.stem}]});
 assert.equal(continued.length,1);assert.deepEqual(continued[0].answerIds,['a','b']);
});
