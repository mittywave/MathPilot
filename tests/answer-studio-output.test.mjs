import {before,after} from 'node:test';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
const nativeFetch=globalThis.fetch;
before(()=>{globalThis.fetch=(url,...args)=>url==='/standard-math-paper.docx'?Promise.resolve(new Response(readFileSync('public/standard-math-paper.docx'))):nativeFetch(url,...args);});
after(()=>{globalThis.fetch=nativeFetch;});
const require=createRequire(import.meta.url);
const box={x:0,y:0,width:500,height:500};
const shape={id:'line',kind:'line',x:10,y:10,width:60,height:40,color:'#C00000',weight:2,dash:false,text:'',points:[]};
const record=(id,pageId)=>({id,lesson:'三角形的外心',section:'例题精练',number:'3',stem:'原题标识 $\\angle A=90^\\circ$。',analysis:'第一步 $r=\\frac{5}{2}$\n第二步 $S=\\pi r^2$',source:{pageId,box},diagramBoxes:[box],warnings:[],continuation:false});
async function modules(t){
  const dir=await mkdtemp(join(tmpdir(),'studio-output-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await build({entryPoints:['lib/answer-studio-pipeline.ts','lib/answer-studio-output.ts','lib/answer-studio-export.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',alias:{docx:require.resolve('docx'),jszip:require.resolve('jszip')},external:[require.resolve('docx'),require.resolve('jszip')],outdir:dir,outExtension:{'.js':'.cjs'},logLevel:'silent'});
  return Object.assign({},...['pipeline','output','export'].map(name=>require(join(dir,`answer-studio-${name}.cjs`))));
}
test('an originals-only paper becomes an editable question Word without answer notes or empty solutions',async t=>{
  const {transcribeStudio,buildStudioWord,studioOutputs}=await modules(t);
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const page={id:'p',role:'question',name:'paper.pdf',page:1,image:png,hash:'p',selected:true};
  const question=(number,stem,diagramBoxes=[])=>({...record(`q${number}`,'p'),number,stem,analysis:'',diagramBoxes});
  const draft={version:1,inputMode:'questions',title:'第一讲',updatedAt:0,pages:[page],questions:[],answers:[]};
  const services={recognize:async()=>[question('1','如图，$\\angle A=90^\\circ$，求 $BC$。',[box]),question('2','计算 $\\frac{1}{2}+\\frac{1}{3}$。')],
    crop:async()=>({image:png,width:300,height:200}),drawings:async()=>assert.fail('question figures need no drawing model'),checkpoint:async()=>{},progress:()=>{}};
  const text=await transcribeStudio(draft,services,{drawings:false});
  assert.ok(text.questions.every(q=>!q.warnings.length),'no answer-matching notes on a question paper');
  assert.deepEqual(studioOutputs(text).map(o=>o.label),['题目版','题目版（无图）']);
  const full=await transcribeStudio(text,services,{drawings:true,includeQuestionFigures:true});
  const zip=await JSZip.loadAsync(await(await buildStudioWord(full,'full',{transcription:true})).arrayBuffer());
  const xml=await zip.file('word/document.xml').async('string');
  assert.match(xml,/第一讲 题目版/);assert.match(xml,/>，求</);assert.match(xml,/<m:f>/);
  assert.equal(zip.file(/^word\/media\//).length,1,'the original figure is embedded once');
  assert.doesNotMatch(xml,/StudioAnswer|未匹配|解析/,'no red solution or warning paragraphs');
  const plain=await JSZip.loadAsync(await(await buildStudioWord(full,'text',{transcription:true})).arrayBuffer());
  assert.equal(plain.file(/^word\/media\//).length,0);
});
test('legacy math exports natively without mutating drafts and failures identify their question',async t=>{
  const {buildStudioWord}=await modules(t);
  const q={...record('q','p'),stem:'弧 $\\overgroup{AB}$，圆 $\\\bigodot O$，$\\\\angle A=30^\\\\circ$',answerIds:[],questionSources:[],diagrams:[],reviewed:false,resolutions:{},answerPlacements:[{kind:'blank',placeholder:'___',answer:'$\bigodot O$'}]};
  const draft={version:1,inputMode:'answers',title:'兼容验证',questions:[q],answers:[],pages:[]};
  const original=structuredClone(draft);
  const xml=await(await JSZip.loadAsync(await(await buildStudioWord(draft,'text',{transcription:true})).arrayBuffer())).file('word/document.xml').async('string');
  assert.match(xml,/<m:chr m:val="⏠"/);assert.match(xml,/>⨀<\/m:t>/);assert.match(xml,/>∠<\/w:t>/);assert.match(xml,/>°<\/w:t>/);
  assert.doesNotMatch(xml,/overgroup|bigodot|angle|<w:drawing|<v:|>\\<\/m:t>/);
  assert.deepEqual(draft,original);
  q.stem='题干 $\\unknown{AB}$';
  await assert.rejects(()=>buildStudioWord(draft,'text',{transcription:true}),/三角形的外心 · 例题精练 · 第 3 题 · 题干：.*unknown/);
  await assert.doesNotReject(()=>buildStudioWord(draft,'steps',{transcription:true}),'unused stem cannot block steps-only output');
  q.answerPlacements[0].answer='$\\unknown{x}$';
  await assert.rejects(()=>buildStudioWord(draft,'steps',{transcription:true}),/第 3 题 · 短答案：.*unknown/);
});
test('warning evidence containing undelimited LaTeX stays literal and cannot block full export',async t=>{
  const {buildStudioWord}=await modules(t);
  const q={...record('q','p'),answerOnly:true,stem:'原题 $x=1$',analysis:'步骤 $x=2$',answerIds:[],questionSources:[],diagrams:[],reviewed:false,resolutions:{},drawingsChecked:true,drawingsRevision:3,drawingDisposition:'question-only',drawingsIncludeQuestionFigures:false,warnings:['原字迹疑似 `6\\sqrt{3}`，请对照原件确认','分值 4\\\'']};
  const draft={version:1,inputMode:'answers',title:'提示文字公式',questions:[q],answers:[],pages:[]};
  const zip=await JSZip.loadAsync(await(await buildStudioWord(draft,'full',{transcription:true})).arrayBuffer());
  const xml=await zip.file('word/document.xml').async('string');
  assert.match(xml,/6\\sqrt\{3\}/);assert.match(xml,/分值/);assert.match(xml,/>2<\/w:t>/);assert.doesNotMatch(xml,/<m:rad>/);
});
test('structured transcription tables remain native Word tables with editable cell math',async t=>{
  const {buildStudioWord}=await modules(t);
  const q={...record('q','p'),stem:'原题',analysis:'过程',answerIds:[],questionSources:[],diagrams:[],tables:[{rows:[['sin','cos','tan'],['$\\frac{1}{2}$','$\\sqrt{3}$','1']],warnings:[],red:false}],reviewed:false,resolutions:{}};
  const draft={version:1,inputMode:'answers',title:'表格验证',questions:[q],answers:[],pages:[]};
  const zip=await JSZip.loadAsync(await(await buildStudioWord(draft,'text',{transcription:true})).arrayBuffer());
  const xml=await zip.file('word/document.xml').async('string');
  assert.equal((xml.match(/<w:tbl>/g)||[]).length,1);assert.equal((xml.match(/<w:tr>/g)||[]).length,2);assert.equal((xml.match(/<w:tc>/g)||[]).length,6);assert.match(xml,/<m:f>/);assert.match(xml,/<m:rad>/);assert.match(xml,/sin/);
});
test('composite blank export contains the final answer rather than the placeholder line',async t=>{
  const {buildStudioWord}=await modules(t);
  const q={...record('q','p'),stem:'分解因式：$(2a-b)^2+8ab=\\underline{\\quad}$。',analysis:'过程：$(2a-b)^2+8ab=(2a+b)^2$。',answerIds:[],questionSources:[],diagrams:[],tables:[],answerPlacements:[{kind:'blank',placeholder:'\\underline{\\quad}',answer:'$(2a+b)^2$'}],reviewed:false,resolutions:{}};
  const draft={version:1,inputMode:'answers',title:'填空验证',questions:[q],answers:[],pages:[]};
  const zip=await JSZip.loadAsync(await(await buildStudioWord(draft,'text',{transcription:true})).arrayBuffer());
  const xml=await zip.file('word/document.xml').async('string');
  assert.match(xml,/>C00000<|w:color w:val="C00000"/);assert.match(xml,/>\+<\/w:t>/);assert.doesNotMatch(xml,/答案空位位于复合公式/);
  assert.match(xml,/<w:u w:val="single"\/>/,'answer remains visibly underlined');
});
test('steps-only output excludes structured tables just like it excludes question text',async t=>{
  const {buildStudioWord}=await modules(t);
  const q={...record('q','p'),stem:'原题',analysis:'步骤',answerIds:[],questionSources:[],diagrams:[],tables:[{rows:[['不应输出']],warnings:[],red:false}],reviewed:false,resolutions:{}};
  const draft={version:1,inputMode:'answers',title:'步骤表格范围',questions:[q],answers:[],pages:[]};
  const zip=await JSZip.loadAsync(await(await buildStudioWord(draft,'steps',{transcription:true})).arrayBuffer());
  const xml=await zip.file('word/document.xml').async('string');
  assert.doesNotMatch(xml,/<w:tbl>|不应输出/);assert.match(xml,/步骤/);
});
test('best-effort full export annotates unsupported formulas instead of aborting',async t=>{
  const {buildStudioWord}=await modules(t);
  const q={...record('q','p'),answerOnly:true,stem:'原题',analysis:'过程 $\\unknown{x}$',answerIds:[],questionSources:[],diagrams:[],tables:[],warnings:[],resolutions:{},drawingsChecked:true,drawingDisposition:'none',drawingsIncludeQuestionFigures:false};
  const draft={version:1,inputMode:'answers',title:'格式问题不中止',questions:[q],answers:[],pages:[]};
  const zip=await JSZip.loadAsync(await(await buildStudioWord(draft,'full',{transcription:true,bestEffort:true,reviewCopy:true})).arrayBuffer());
  const xml=await zip.file('word/document.xml').async('string');
  assert.match(xml,/格式问题/);assert.match(xml,/Unsupported math command.*unknown/);assert.match(xml,/过程/);
});
test('input evidence is independent of output; text stage makes zero crop/drawing calls and full resumes',async t=>{
  const {transcribeStudio,buildStudioWord,studioOutputBlocker}=await modules(t);
  for(const inputMode of ['paired','answers']){
    const pages=[...(inputMode==='paired'?[{id:'q',role:'question'}]:[]),{id:'a',role:'answer'}].map(p=>({...p,name:'source.pdf',page:1,image:'evidence',hash:p.id,selected:true}));
    const draft={version:1,inputMode,title:'样本',pages,questions:[],answers:[],updatedAt:0};
    let recognition=0;
    const services={recognize:async p=>{recognition++;return [record(p.id,p.id)];},crop:async()=>assert.fail('text mode cannot crop'),drawings:async()=>assert.fail('text mode cannot call drawing AI'),checkpoint:async()=>{},progress:()=>{}};
    const text=await transcribeStudio(draft,services,{drawings:false});
    assert.equal(recognition,pages.length);assert.equal(text.questions.length,1);assert.notEqual(text.questions[0].drawingsChecked,true);
    for(const mode of ['full','text','steps'])assert.equal(studioOutputBlocker(text,mode),'');
    for(const mode of ['text','steps']){
      const zip=await JSZip.loadAsync(await(await buildStudioWord(text,mode,{transcription:true})).arrayBuffer());
      const xml=await zip.file('word/document.xml').async('string');
      assert.equal(xml.includes('原题标识'),mode==='text');assert.match(xml,/第一步/);assert.match(xml,/第二步/);assert.match(xml,/<m:f>/);
      assert.doesNotMatch(xml,/<v:|<w:drawing|STUDIO_DIAGRAM_|尚未检查解答图/);
      assert.equal(Object.keys(zip.files).filter(p=>/^word\/media\/.+/.test(p)).length,0);
    }
    await assert.rejects(()=>buildStudioWord(text,'full',{transcription:true}),/配图/);
    const full=await transcribeStudio(text,{...services,recognize:async()=>assert.fail('must reuse text'),crop:async()=>({image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',width:100,height:100}),drawings:async(q,bases,evidence,context)=>{assert.equal(context.answerOnly,inputMode==='answers');return {disposition:'solution',warnings:[],diagrams:[{baseIndex:bases.length?0:-1,caption:'解答辅助图',shapes:[shape],warnings:[]}]};}},{includeQuestionFigures:inputMode==='paired'});
    const zip=await JSZip.loadAsync(await(await buildStudioWord(full,'full',{transcription:true})).arrayBuffer());
    assert.match(await zip.file('word/document.xml').async('string'),/<v:line/);
    const repeat=await transcribeStudio(full,{...services,recognize:async()=>assert.fail()},{includeQuestionFigures:inputMode==='paired'});
    assert.deepEqual(repeat.questions[0].diagrams,full.questions[0].diagrams);
    assert.equal(text.questions[0].diagrams.length,0,'exports do not mutate shared draft');
  }
});
test('source figure boxes retain boundary strokes without extending beyond the page',async t=>{
  const {studioPaddedDiagramBox}=await modules(t);
  assert.deepEqual(studioPaddedDiagramBox({x:100,y:200,width:300,height:400}),{x:95,y:195,width:310,height:410});
  assert.deepEqual(studioPaddedDiagramBox({x:0,y:2,width:1000,height:996}),{x:0,y:0,width:1000,height:1000});
});
test('legacy unclassified caches are reclassified once while text exports still bypass drawings',async t=>{
  const {transcribeStudio,studioFiguresReady,buildStudioWord}=await modules(t);
  const answer=record('a','p');
  const question={...answer,id:'q',answerOnly:true,drawingsChecked:true,drawingsRevision:3,answerIds:['a'],questionSources:[],diagrams:[{id:'old',width:100,height:100,baseImage:'',caption:'旧题图',shapes:[shape],warnings:[]}],warnings:[],reviewed:false,resolutions:{}};
  const draft={version:1,inputMode:'answers',title:'旧草稿',pages:[{id:'p',page:1,name:'source.pdf',role:'answer',selected:true,processed:true,image:'evidence'}],questions:[question],answers:[answer]};
  assert.equal(studioFiguresReady(question,draft),false);
  for(const mode of ['text','steps'])await buildStudioWord(draft,mode,{transcription:true});
  let calls=0;
  const service={recognize:async()=>assert.fail('do not redo text'),crop:async()=>({image:'e',width:100,height:100}),checkpoint:async()=>{},progress:()=>{},drawings:async()=>{calls++;return {disposition:'question-only',warnings:[],diagrams:[]};}};
  const result=await transcribeStudio(draft,service,{includeQuestionFigures:false});
  assert.equal(calls,1);assert.equal(result.questions[0].diagrams.length,0);assert.equal(studioFiguresReady(result.questions[0],result),true);
  await transcribeStudio(result,service,{includeQuestionFigures:false});assert.equal(calls,1);
});
test('missing stems block only stem outputs; existing figures and captions never leak into no-image exports',async t=>{
  const {buildStudioWord,studioOutputBlocker,studioIssueCount}=await modules(t);
  const answer=record('a','p');
  const q={...answer,id:'q',answerOnly:true,stem:'',answerIds:['a'],questionSources:[],drawingsChecked:true,drawingDisposition:'question-only',diagrams:[{id:'g',baseImage:'invalid image intentionally unvisited',width:100,height:100,caption:'不应输出图注',shapes:[shape],warnings:['不应输出图警告']}],reviewed:false,resolutions:{},warnings:[]};
  const draft={version:1,inputMode:'answers',title:'回归',pages:[],questions:[q],answers:[answer]};
  assert.equal(studioIssueCount(draft),1);
  assert.equal(studioOutputBlocker(draft,'full'),'');assert.equal(studioOutputBlocker(draft,'text'),'');assert.equal(studioOutputBlocker(draft,'steps'),'');
  for(const mode of ['full','text'])await buildStudioWord(draft,mode,{transcription:true,bestEffort:true,reviewCopy:true});
  for(const mode of ['steps','text']){
    if(mode==='text')q.stem='有原题内容';
    const xml=await(await JSZip.loadAsync(await(await buildStudioWord(draft,mode,{transcription:true})).arrayBuffer())).file('word/document.xml').async('string');
    assert.doesNotMatch(xml,/不应输出|<v:|STUDIO_DIAGRAM_/);assert.match(xml,/<m:oMath>/);
  }
  q.analysis='更新步骤 $x=7$';
  for(const mode of ['text','steps']){
    const xml=await(await JSZip.loadAsync(await(await buildStudioWord(draft,mode,{transcription:true})).arrayBuffer())).file('word/document.xml').async('string');
    assert.match(xml,/更新步骤/);assert.doesNotMatch(xml,/第一步/);
  }
});
test('full output upgrades previously omitted printed figures without redoing completed geometry',async t=>{
  const {transcribeStudio}=await modules(t);
  const answer={...record('a','p'),analysis:'C',answerPlacements:[{kind:'choice',placeholder:'( )',answer:'C'}]};
  const question={...answer,id:'q',answerOnly:true,drawingsChecked:true,drawingsRevision:3,answerIds:['a'],questionSources:[],diagrams:[],warnings:[],reviewed:false,resolutions:{}};
  const draft={version:1,inputMode:'answers',title:'选择题',pages:[{id:'p',page:57,name:'source.pdf',role:'answer',selected:true,processed:true,image:'evidence'}],questions:[question],answers:[answer]};
  let calls=0;
  const service={recognize:async()=>assert.fail(),crop:async()=>({image:'e',width:100,height:100}),checkpoint:async()=>{},progress:()=>{},drawings:async(q,b,e,c)=>{calls++;assert.equal(c.answerOnly,false);return {disposition:'question-only',warnings:[],diagrams:[{baseIndex:-1,caption:'选项',shapes:[shape],warnings:[]}]};}};
  const result=await transcribeStudio(draft,service,{includeQuestionFigures:true});
  assert.equal(calls,1);assert.equal(result.questions[0].diagrams.length,1);
  await transcribeStudio(result,service,{includeQuestionFigures:true});assert.equal(calls,1);
});

test('full answers-material output omits pure question diagrams for non-choice solutions too',async t=>{
  const {transcribeStudio,buildStudioWord}=await modules(t);
  const answer=record('a','p');
  const draft={version:1,inputMode:'answers',title:'仅答案材料',pages:[{id:'p',page:1,name:'source.pdf',role:'answer',selected:true,image:'evidence'}],questions:[],answers:[]};
  const service={recognize:async()=>[answer],crop:async()=>({image:'e',width:100,height:100}),checkpoint:async()=>{},progress:()=>{},drawings:async(q,b,e,c)=>{assert.equal(c.answerOnly,true);return {disposition:'question-only',warnings:[],diagrams:[]};}};
  const result=await transcribeStudio(draft,service,{includeQuestionFigures:false});
  assert.equal(result.questions[0].drawingDisposition,'question-only');assert.equal(result.questions[0].diagrams.length,0);
  // A previous all-figures draft may already contain a classified question
  // figure: preserve the data, but never leak it into this export policy.
  result.questions[0].diagrams=[{id:'old-question',width:100,height:100,baseImage:'invalid unused original',caption:'纯原题图不得输出',shapes:[shape],warnings:[]}];
  const xml=await(await JSZip.loadAsync(await(await buildStudioWord(result,'full',{transcription:true})).arrayBuffer())).file('word/document.xml').async('string');
  assert.match(xml,/原题标识/);assert.match(xml,/第一步/);assert.doesNotMatch(xml,/纯原题图|<v:line|<v:imagedata/);
  assert.equal(result.questions[0].diagrams.length,1,'do not destructively remove cached evidence');
  const failed=await transcribeStudio(draft,{...service,drawings:async()=>({disposition:'uncertain',warnings:['模糊'],diagrams:[]})},{includeQuestionFigures:false});
  assert.equal(failed.questions[0].drawingsChecked,false);assert.ok(failed.questions[0].warnings.some(w=>w.includes('配图处理失败')));
});
