import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {preparePdfWorker} from '../scripts/prepare-pdf-worker.mjs';
const require=createRequire(import.meta.url);
const box={x:50,y:50,width:800,height:300};
const shape={id:'s',kind:'line',x:-10,y:0,width:100,height:80,color:'#C00000',weight:2,dash:false,text:'',points:[]};
const page=(id,role)=>({id,role,name:'sample.pdf',page:1,image:'image',hash:id,selected:true});
const record=(id,pageId,patch={})=>({id,lesson:'第一讲',section:'例题',number:'1',stem:'同一个原题 $x=1$',analysis:'完整解答 $x=2$',source:{pageId,box},diagramBoxes:[],warnings:[],continuation:false,...patch});

async function moduleFixture(t){
  const dir=await mkdtemp(join(tmpdir(),'studio-pipeline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await build({entryPoints:['lib/answer-studio-pipeline.ts','lib/answer-studio-layout.ts','lib/answer-studio-normalize.ts','lib/answer-studio-drawings.ts','lib/answer-studio-contract.ts'],outdir:dir,bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},logLevel:'silent'});
  return {...require(join(dir,'answer-studio-pipeline.cjs')),...require(join(dir,'answer-studio-layout.cjs')),...require(join(dir,'answer-studio-normalize.cjs')),...require(join(dir,'answer-studio-drawings.cjs')),...require(join(dir,'answer-studio-contract.cjs'))};
}
test('document templates are all committed before content fill; retries reuse templates and merge answer continuations without dropping repeated stems',async t=>{
  const {transcribeStudio,fillStudioDocumentTemplate,studioDocumentReady,studioDocumentParts,studioDocumentQuestionCount}=await moduleFixture(t);
  const structure=(kind,role,continued=false)=>({printed:true,parts:[{kind,title:continued?'':'原卷标题',heading:kind==='answers'&&!continued?'参考答案与试题解析':'',continuation:continued,sections:[{title:'解答题',continuation:continued,questions:[{number:'1',continuation:continued,blocks:[{id:'b1',role,box,continuation:continued}]}]}]}],warnings:[]});
  const templates=[structure('questions','stem'),structure('answers','solution'),structure('answers','body',true)];
  templates[2].parts[0].sections[0].title='原栏目简称（续）';
  templates[2].parts[0].sections[0].questions[0].number='26';
  const draft={version:1,inputMode:'questions',title:'任务名称',updatedAt:0,pages:[1,2,3].map(n=>({...page(`p${n}`,'question'),page:n,textHint:`第${n}页正文`})),questions:[],answers:[]};
  let last,structureCalls=0,fail=true;const contentCalls=[];
  const services={structure:async p=>{structureCalls++;return templates[p.page-1];},recognize:async(p,context,options)=>{
    assert.equal(options.structured,true);assert.ok(last.pages.every(p=>p.document),'recognition must not run before the complete outline is committed');contentCalls.push(p.page);
    if(p.page===2&&fail)throw new Error('一次内容识别失败');
    const text=['1．计算 $x^2$。','【解答】解：$x=1$，','续页原文。'][p.page-1];
    return {records:[],document:fillStudioDocumentTemplate(p.document,{blocks:[{id:'b1',text,rows:[]}],warnings:[]})};
  },checkpoint:async value=>{last=value;},progress:()=>{},crop:async()=>assert.fail('printed figures are copied from source, never redrawn'),drawings:async()=>assert.fail()};
  await assert.rejects(()=>transcribeStudio(draft,services,{drawings:false,textConcurrency:4}),/一次内容识别失败/);
  assert.equal(structureCalls,3);assert.equal(last.pages[0].processed,true);assert.equal(last.pages[1].processed,undefined);assert.equal(last.pages[2].processed,undefined);
  fail=false;const result=await transcribeStudio(last,services,{drawings:true,textConcurrency:4});
  assert.equal(structureCalls,3);assert.deepEqual(contentCalls,[1,2,3,2]);assert.ok(studioDocumentReady(result));assert.equal(studioDocumentQuestionCount(result),1);
  const parts=studioDocumentParts(result);assert.equal(parts.length,2);assert.equal(parts[1].sections[0].title,'解答题','an explicit continuation keeps the original printed section, even when a page infers a shorter title');assert.equal(parts[1].sections[0].questions[0].number,'1','a formula number inferred on a continuation must not replace the original question number');assert.equal(parts[0].sections[0].questions[0].blocks[0].text,'1．计算 $x^2$。');assert.equal(parts[1].sections[0].questions[0].blocks[0].text,'【解答】解：$x=1$，续页原文。');assert.equal(draft.pages[0].document,undefined);
  const illustrated=structuredClone(result);illustrated.pages[2].document.parts[0].sections[0].questions[0].blocks.unshift({id:'figure',role:'figure',box,continuation:true,text:'',rows:[]});
  const illustration=studioDocumentParts(illustrated)[1].sections[0].questions[0].blocks;assert.deepEqual(illustration.map(b=>b.role),['solution','figure','body']);assert.equal(illustration[2].text,'续页原文。','a diagram continued with the question cannot swallow following text or be concatenated into a paragraph');
  const numbered=structuredClone(result);numbered.pages[2].document.parts[0].sections[0].questions[0].blocks[0].text='（2）另起的分问。';assert.equal(studioDocumentParts(numbered)[1].sections[0].questions[0].blocks.length,2,'a new numbered subpart starts its own paragraph even when the question continues across pages');
  const samePage=structuredClone(result),sameBlocks=samePage.pages[2].document.parts[0].sections[0].questions[0].blocks;sameBlocks.push({...sameBlocks[0],id:'b2',text:'同页独立段落。'});assert.equal(studioDocumentParts(samePage)[1].sections[0].questions[0].blocks.length,2,'continuation cannot concatenate later independent blocks on the same page');
});
test('document filling requires every template slot exactly once and retains native table cell math',async t=>{
  const {normalizeStudioDocumentTemplate,fillStudioDocumentTemplate}=await moduleFixture(t);
  const template=normalizeStudioDocumentTemplate({printed:true,parts:[{kind:'questions',title:'标准试卷',heading:'',continuation:false,sections:[{title:'填空题',continuation:false,questions:[{number:'1',continuation:false,blocks:[{id:'b1',role:'stem',box,continuation:false},{id:'b2',role:'table',box,continuation:false}]}]}]}],warnings:[]});
  const content={blocks:[{id:'b1',text:'1．填表。',rows:[]},{id:'b2',text:'',rows:[['数','值'],['$\\frac{1}{2}$','$\\sqrt{3}$']]}],warnings:[]};
  const result=fillStudioDocumentTemplate(template,content);assert.equal(result.parts[0].sections[0].questions[0].blocks[1].rows[1][0],'$\\frac{1}{2}$');assert.equal(template.parts[0].sections[0].questions[0].blocks[0].text,undefined);
  assert.throws(()=>fillStudioDocumentTemplate(template,{...content,blocks:content.blocks.slice(0,1)}),/不能遗漏/);
  assert.throws(()=>fillStudioDocumentTemplate(template,{...content,blocks:[content.blocks[0],content.blocks[0]]}),/重复/);
  assert.throws(()=>fillStudioDocumentTemplate(template,{...content,blocks:[content.blocks[0],{...content.blocks[1],id:'unknown'}]}),/未知/);
  assert.throws(()=>normalizeStudioDocumentTemplate({...template,parts:[{...template.parts[0],sections:[{...template.parts[0].sections[0],questions:[{number:'1',continuation:false,blocks:[{id:'b1',role:'figure',box:{x:0,y:0,width:1000,height:1000},continuation:false}]}]}]}]}),/整页正文/);
});
test('native paragraph text overlapping a figure edge remains complete prose and is excluded from the picture',async t=>{
  const {normalizeStudioDocumentTemplate,fillStudioDocumentTemplate}=await moduleFixture(t);
  for(const [figureBox,stemBox,baseline] of [
    [{x:100,y:100,width:600,height:110},{x:90,y:200,width:800,height:40},205],
    [{x:100,y:130,width:600,height:120},{x:90,y:100,width:800,height:40},135],
    [{x:100,y:100,width:600,height:100},{x:90,y:300,width:800,height:40},315],
  ]){
    const text='7．（3分）这是相邻题目的完整正文，不能因图框偏大而被误判为多余文字。';
    const figure={id:'figure',role:'figure',box:figureBox,continuation:false},stem={id:'stem',role:'stem',box:stemBox,continuation:false};
    const blocks=figureBox.y<stemBox.y?[figure,stem]:[stem,figure];
    const raw={printed:true,parts:[{kind:'questions',title:'图文边界',heading:'',continuation:false,sections:[{title:'',continuation:false,questions:[{number:'7',continuation:false,blocks}]}]}],warnings:[]};
    const figureY=figureBox.y<stemBox.y?figureBox.y+20:figureBox.y+70;
    const hint=[[200,40,15,'图文边界'],[90,baseline,10.5,'7．'],[120,baseline,10.5,text.slice(2)],[200,figureY,10.5,'水池']].map(JSON.stringify).join('\n');
    const template=normalizeStudioDocumentTemplate(raw,hint),before=structuredClone(template),content={blocks:[{id:'figure',text:'',rows:[]},{id:'stem',text,rows:[]}],warnings:[]};
    const result=fillStudioDocumentTemplate(template,content,hint),filled=result.parts[0].sections[0].questions[0].blocks;
    const box=filled.find(b=>b.role==='figure').box;
    assert.equal(filled.find(b=>b.role==='stem').text,text);
    assert.ok(baseline<box.y-4||baseline>box.y+box.height+4,'native prose must remain outside figure membership, including its tolerance');
    assert.ok(figureY>=box.y&&figureY<=box.y+box.height,'native labels belonging only to the figure stay inside it');
    assert.deepEqual(template,before,'calibration cannot mutate the cached template');
    assert.throws(()=>fillStudioDocumentTemplate(template,{...content,blocks:[content.blocks[0],{...content.blocks[1],text:text.replace('完整正文','正文')}]},hint),/印刷文字不完整/,'genuinely missing prose must still fail');
    if(figureBox.y+figureBox.height<stemBox.y)assert.deepEqual(box,figureBox,'well separated source boxes stay unchanged');
  }
});
test('digital PDF prose preserves source typos and rejects omitted paragraphs, wrong numbers and wrong marks',async t=>{
  const {normalizeStudioDocumentTemplate,fillStudioDocumentTemplate}=await moduleFixture(t);
  const raw={printed:true,parts:[{kind:'questions',title:'标准试卷',heading:'',continuation:false,sections:[{title:'填空题',continuation:false,questions:[{number:'1',continuation:false,blocks:[{id:'b1',role:'stem',box,continuation:false}]}]}]}],warnings:[]};
  const hint=[[200,20,15,'标准试卷'],[50,40,10.5,'填空题'],[60,100,10.5,'1．（3分）原文表知敷。'],[100,900,.5,'白字元数据'],[450,940,9,'第1页']].map(JSON.stringify).join('\n');
  const template=normalizeStudioDocumentTemplate(raw,hint);
  const content={blocks:[{id:'b1',text:'1．（3分）原文未知数。',rows:[]}],warnings:[]};
  const result=fillStudioDocumentTemplate(template,content,hint);assert.equal(result.parts[0].sections[0].questions[0].blocks[0].text,'1．（3分）原文表知敷。');assert.equal(content.blocks[0].text,'1．（3分）原文未知数。');
  assert.throws(()=>fillStudioDocumentTemplate(template,{...content,blocks:[{...content.blocks[0],text:'1．（3分）原文。'}]},hint),/印刷文字不完整/);
  assert.throws(()=>fillStudioDocumentTemplate(template,{...content,blocks:[{...content.blocks[0],text:'2．（3分）原文未知数。'}]},hint),/题号/);
  assert.throws(()=>fillStudioDocumentTemplate(template,{...content,blocks:[{...content.blocks[0],text:'1．（4分）原文未知数。'}]},hint),/分值/);
  assert.throws(()=>normalizeStudioDocumentTemplate({printed:true,parts:[],warnings:[]},hint),/结构模板漏掉/);
  assert.throws(()=>normalizeStudioDocumentTemplate(raw,hint+'\n'+JSON.stringify([60,500,10.5,'x=2'])),/段落或公式行/,'math-only lines cannot disappear merely because they contain no Chinese');
  const mergedSteps=structuredClone(raw);mergedSteps.parts[0].sections[0].questions[0].blocks[0].role='solution';
  assert.throws(()=>normalizeStudioDocumentTemplate(mergedSteps,hint+'\n'+[[50,200,10.5,'=1'],[50,250,10.5,'=2']].map(JSON.stringify).join('\n')),/独立演算行/,'independent left-aligned derivation rows must not be packed into a single solution slot');
  mergedSteps.parts[0].sections[0].questions[0].blocks[0].role='body';assert.throws(()=>normalizeStudioDocumentTemplate(mergedSteps,hint+'\n'+[[50,200,10.5,'=1'],[50,250,10.5,'=2']].map(JSON.stringify).join('\n')),/独立演算行/,'renaming a merged solution as body cannot bypass paragraph validation');
  const headers=hint.split('\n').slice(0,2).join('\n'),shortRows=[[50,100,10.5,'第一段。'],[50,170,10.5,'第二段。'],[50,240,10.5,'第三段。']];
  assert.throws(()=>normalizeStudioDocumentTemplate(mergedSteps,headers+'\n'+shortRows.map(JSON.stringify).join('\n')),/已经结束的短段落/,'short finished prose rows must not merge whole inequality proofs into a single slot');
  assert.throws(()=>normalizeStudioDocumentTemplate(mergedSteps,headers+'\n'+shortRows.slice(0,2).map(JSON.stringify).join('\n')),/已经结束的短段落/,'an introductory sentence and a separate case heading must remain separate paragraphs');
  assert.doesNotThrow(()=>normalizeStudioDocumentTemplate(mergedSteps,headers+'\n'+shortRows.map(r=>JSON.stringify([...r.slice(0,3),'甲'.repeat(50)+'，'])).join('\n')),'natural full-width prose wrapping remains a single paragraph');
  const wrongYear=structuredClone(raw);wrongYear.parts[0].title='2024标准试卷';assert.throws(()=>normalizeStudioDocumentTemplate(wrongYear,hint.replace('标准试卷','2025标准试卷')),/卷名年份/);
  const geometryHint=hint+'\n'+JSON.stringify([200,100,10.5,'∠=180°，△≌△']);
  const geometry={blocks:[{id:'b1',text:'1．（3分）原文未知数。$\\triangle A=180^\top$，$\\triangle ABC\\sim\\triangle DEF$。',rows:[]}],warnings:[]};
  const restored=fillStudioDocumentTemplate(template,geometry,geometryHint).parts[0].sections[0].questions[0].blocks[0].text;
  assert.match(restored,/\\angle\s+A=180\^\\circ/);assert.match(restored,/\\cong/);assert.doesNotMatch(restored,/\top/,'a decoded unknown tab escape cannot leak op in place of a printed degree');
  assert.throws(()=>fillStudioDocumentTemplate(template,content,geometryHint),/几何符号不完整/);
  const wrong=structuredClone(raw);wrong.parts[0].sections[0].questions[0].number='2';assert.throws(()=>normalizeStudioDocumentTemplate(wrong,hint),/题号结构与原件不一致/);
});
test('a structure-stage run slice preserves its cause and successful template for queue resumption',async t=>{
  const {transcribeStudio}=await moduleFixture(t);const yieldError=new Error('本轮运行时间已到');
  const template={printed:true,parts:[],warnings:[]};let last,calls=0;
  const draft={version:1,inputMode:'questions',title:'模板断点',updatedAt:0,pages:[1,2].map(n=>({...page('p'+n,'question'),page:n})),questions:[],answers:[]};
  await assert.rejects(()=>transcribeStudio(draft,{structure:async p=>{calls++;if(p.page===2)throw yieldError;return template;},recognize:async()=>assert.fail('content cannot start before all templates exist'),checkpoint:async value=>{last=value;},progress:()=>{},crop:async()=>assert.fail(),drawings:async()=>assert.fail()},{drawings:false}),error=>error.cause===yieldError);
  assert.equal(calls,2);assert.equal(last.pages[0].document.printed,true);assert.equal(last.pages[1].document,undefined);
});
test('both workflows automatically inspect drawings, preserve continuation and never fabricate review',async t=>{
  const {transcribeStudio}=await moduleFixture(t);
  for(const mode of ['answers','paired']){
    let drawingCalls=0,last;
    const draft={version:1,inputMode:mode,title:'第一讲',updatedAt:0,pages:[...(mode==='paired'?[page('q','question')]:[]),page('a','answer'),page('b','answer')],questions:[],answers:[]};
    const result=await transcribeStudio(draft,{
      recognize:async p=>p.role==='question'?[record('q1',p.id,{analysis:'',diagramBoxes:[box]})]:[record(p.id,p.id,p.id==='b'?{analysis:'续页原文',continuation:true}:{})],
      crop:async()=>({image:'base',width:300,height:200}),
      drawings:async(q,bases,evidence)=>{drawingCalls++;assert.equal(evidence.length,2);assert.match(q.analysis,/续页原文/);return {warnings:[],diagrams:[{baseIndex:bases.length?0:-1,caption:'(1)',shapes:[shape],warnings:[]}]};},
      checkpoint:async d=>{last=d;},progress:()=>{},
    });
    assert.equal(result.questions.length,1);assert.equal(drawingCalls,1);
    assert.equal(result.questions[0].reviewed,false);assert.deepEqual(result.questions[0].resolutions,{});
    assert.equal(result.questions[0].diagrams[0].shapes.length,1);
    assert.equal(result.questions[0].diagrams[0].baseImage,mode==='paired'?'base':'');
    assert.equal(result.questions[0].drawingsChecked,true);assert.ok(last.pages.every(p=>p.processed));
    assert.equal(draft.questions.length,0,'caller and source evidence are not mutated');
    await transcribeStudio(last,{recognize:async()=>assert.fail('must not recognize completed pages again'),crop:async()=>assert.fail(),drawings:async()=>assert.fail(),checkpoint:async()=>{},progress:()=>{}});
    last.questions[0].drawingsRevision=0;
    const upgraded=await transcribeStudio(last,{recognize:async()=>assert.fail(),crop:async()=>({image:'e',width:300,height:200}),drawings:async(q,bases)=>{assert.ok(bases.every(d=>d.shapes.length===0),'revision must not feed previous overlay back as a source');return {warnings:[],diagrams:[{baseIndex:bases.length?0:-1,caption:'new',shapes:[{...shape,id:'new'}],warnings:[]}]};},checkpoint:async()=>{},progress:()=>{}});
    assert.equal(upgraded.questions[0].diagrams.length,1);
    assert.deepEqual(upgraded.questions[0].diagrams[0].shapes.map(s=>s.id),['new']);
  }
});
test('known missing diagrams fail visibly and resume only the failed drawing stage',async t=>{
  const {transcribeStudio}=await moduleFixture(t);
  const draft={version:1,inputMode:'answers',title:'验证',updatedAt:0,pages:[page('a','answer')],questions:[],answers:[]};
  const service={recognize:async()=>[record('a','a',{diagramBoxes:[box]})],crop:async()=>({image:'evidence',width:300,height:200}),drawings:async()=>({warnings:[],diagrams:[]}),checkpoint:async()=>{},progress:()=>{}};
  const first=await transcribeStudio(draft,service);
  assert.equal(first.pages[0].processed,true);assert.notEqual(first.questions[0].drawingsChecked,true);assert.ok(first.questions[0].warnings.some(w=>w.includes('配图处理失败')));
  const result=await transcribeStudio(first,{...service,recognize:async()=>assert.fail(),drawings:async(q,b,evidence)=>{assert.equal(evidence.length,2,'context and diagram close-up are both sent');return {warnings:[],diagrams:[{baseIndex:-1,caption:'(1)',warnings:[],shapes:[shape]},{baseIndex:-1,caption:'(2)',warnings:[],shapes:[shape]}]};}});
  assert.equal(result.questions[0].diagrams.length,2);
});
test('answer-only printed choice figures do not block, while unknown figure results remain visible',async t=>{
  const {transcribeStudio}=await moduleFixture(t);
  const answer=record('logo','a',{lesson:'力争上游',section:'一、选择题',number:'2',analysis:'C',diagramBoxes:[box],answerPlacements:[{kind:'choice',placeholder:'( )',answer:'C'}]});
  const draft={version:1,inputMode:'answers',title:'验证',updatedAt:0,pages:[page('a','answer')],questions:[],answers:[]};
  const base={recognize:async()=>[answer],crop:async()=>({image:'e',width:100,height:100}),checkpoint:async()=>{},progress:()=>{}};
  const ok=await transcribeStudio(draft,{...base,drawings:async()=>({disposition:'question-only',diagrams:[],warnings:[]})});
  assert.equal(ok.questions[0].drawingsChecked,true);assert.equal(ok.questions[0].diagrams.length,0);
  const failed=await transcribeStudio(draft,{...base,drawings:async()=>({diagrams:[],warnings:[]})});
  assert.equal(failed.questions[0].drawingsChecked,false);assert.ok(failed.questions[0].warnings.some(w=>w.includes('配图处理失败')));
});
test('diagram QA renders candidate vectors and replaces them with the complete visual correction',async t=>{
  const {recognizeStudioDrawings}=await moduleFixture(t);let calls=0,contacts=0;
  const first={warnings:[],diagrams:[{baseIndex:-1,caption:'',shapes:[shape],warnings:[]}]};
  const corrected={warnings:['原件标签模糊'],diagrams:[{...first.diagrams[0],shapes:[shape,{...shape,id:'missing-connection'}]}]};
  const result=await recognizeStudioDrawings({stem:'原题',analysis:'原文'},[],['context','close-up'],async body=>{
    calls++;if(calls===1){assert.equal(body.previous,undefined);return first;}
    assert.equal(body.previous,first);assert.equal(body.image,'contact-2');return corrected;
  },{contact:async(b,e,previews=[])=>{contacts++;assert.equal(e.length,2);assert.equal(previews.length,contacts===1?0:1);return `contact-${contacts}`;},render:async svg=>{assert.match(decodeURIComponent(svg),/<line\b/);return 'rendered-preview';}});
  assert.equal(calls,2);assert.equal(result,corrected);assert.equal(result.diagrams[0].shapes.length,2);
});
test('ambiguous paired matches keep all answer entries instead of silently dropping them',async t=>{
  const {transcribeStudio}=await moduleFixture(t);
  const draft={version:1,inputMode:'paired',title:'验证',updatedAt:0,pages:[page('q','question'),page('a','answer')],questions:[],answers:[]};
  const result=await transcribeStudio(draft,{recognize:async p=>[record(p.id,p.id,{stem:p.id==='q'?'原题版本一':'不同的另一个版本'})],crop:async()=>({image:'e',width:100,height:100}),drawings:async()=>({warnings:[],diagrams:[]}),checkpoint:async()=>{},progress:()=>{}});
  assert.equal(result.questions.length,2);assert.equal(result.questions[1].answerOnly,true);
  assert.deepEqual(result.questions.flatMap(q=>q.answerIds),['a']);
  assert.ok(result.questions[1].warnings.some(w=>w.includes('未能唯一匹配')));
});
test('choice and fill slots preserve wording and decline ambiguous mappings',async t=>{
  const {placeStudioAnswers}=await moduleFixture(t);
  const placements=[{kind:'choice',placeholder:'（ ）',answer:'B'},{kind:'blank',placeholder:'___',answer:'$\\frac{1}{2}$'}];
  const result=placeStudioAnswers('选择（　），结果________。',placements);
  assert.deepEqual(result.warnings,[]);assert.deepEqual(result.parts.filter(p=>p.red),[{text:'B',red:true},{text:'$\\frac{1}{2}$',red:true,underline:true}]);
  assert.equal(result.parts.map(p=>p.text).join(''),'选择（B），结果$\\frac{1}{2}$。');
  assert.equal(placeStudioAnswers('结果____与____',placements.slice(1)).warnings.length,1);
  assert.equal(placeStudioAnswers('值$\\underline{\\quad}$。',placements.slice(1)).warnings.length,0);
  assert.equal(placeStudioAnswers('$x=____$',placements.slice(1)).warnings.length,1,'never split an enclosing formula');
});
test('PDF worker preparation serves exactly the package bytes under a versioned URL',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'studio-worker-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const url=await preparePdfWorker(dir);
  assert.match(url,/^\/pdfjs\/\d+\.\d+\.\d+\/pdf.worker.min.mjs$/);
  const actual=await readFile(join(dir,'public',url));
  const original=await readFile(require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'));
  assert.deepEqual(actual,original);assert.doesNotMatch(actual.toString(),/dev-error-overlay|\/@vite\/client/);
  // The data PDF.js loads on demand is served beside it; without it Chinese text in a font that is not embedded and
  // JPEG 2000 scans render as blank pages.
  const folder=dirname(join(dir,'public',url)),pkg=dirname(require.resolve('pdfjs-dist/package.json'));
  for(const [data,sample] of [['cmaps','UniGB-UTF16-H.bcmap'],['standard_fonts','FoxitSerif.pfb'],['wasm','openjpeg.wasm'],['iccs','CGATS001Compat-v2-micro.icc']])
    assert.deepEqual(await readFile(join(folder,data,sample)),await readFile(join(pkg,data,sample)),data);
  // Every PDF reader opens PDFs through lib/pdfjs.ts, which uses this copy: a ?url worker gets Vite's page-only client
  // injected in development.
  const opener=await readFile('lib/pdfjs.ts','utf8');
  assert.match(opener,/workerSrc\s*=\s*`\$\{base\}pdf\.worker\.min\.mjs`/);
  for(const option of ['cMapUrl','standardFontDataUrl','wasmUrl','iccUrl'])assert.match(opener,new RegExp(`${option}: \`\\$\\{base\\}`),option);
  // 题库 file imports read PDFs through lib/answer-studio-images.ts, as 文件转录 does.
  for(const file of ['lib/answer-studio-images.ts','app/tools/typeset/PdfPreview.tsx']){
    const source=await readFile(file,'utf8');
    assert.doesNotMatch(source,/pdf\.worker\.min\.mjs|getDocument\(/,file);assert.match(source,/openPdf\(/,file);
  }
});
test('JSON control escapes are repaired only for known commands inside explicit math',async t=>{
  const {normalizeStudioTextFields,normalizeStudioMathEscapes}=await moduleFixture(t);
  const repaired=normalizeStudioTextFields({stem:'原文\t保持\n$\triangle ABC$和$\frac{1}{2}$',analysis:'$\text{cm}$，$\because x=2$，$\right)$',warnings:['字迹模糊','识别结果含异常控制字符，请对照原件修复公式'],answerPlacements:[{kind:'blank',placeholder:'___',answer:'$\frac{2}{3}$'}]});
  assert.equal(repaired.stem,'原文\t保持\n$\\triangle ABC$和$\\frac{1}{2}$');
  assert.equal(repaired.analysis,'$\\text{cm}$，$\\because x=2$，$\\right)$');
  assert.equal(repaired.answerPlacements[0].answer,'$\\frac{2}{3}$');
  assert.deepEqual(repaired.warnings,['字迹模糊']);
  assert.equal(normalizeStudioMathEscapes('普通文字\ttriangle\n$\\begin{cases}x=1\\\\y=2\\end{cases}$'),'普通文字\ttriangle\n$\\begin{cases}x=1\\\\y=2\\end{cases}$');
  assert.ok(normalizeStudioTextFields({...repaired,analysis:'$\funknown$'}).warnings.some(w=>w.includes('异常控制')),'unknown control damage must remain visible');
});
test('legacy circle escape damage repairs once without creating a doubled command',async t=>{
  const {normalizeStudioMathEscapes}=await moduleFixture(t);
  for(const prefix of ['', '\\', '\\\\', '\\\\\\']){
    const damaged=`原文\b保持 $${prefix}\bigodot O$`;
    const normalized=normalizeStudioMathEscapes(damaged);
    assert.equal(normalized,'原文\b保持 $\\bigodot O$');
    assert.equal(normalizeStudioMathEscapes(normalized),normalized,'normalization is idempotent');
  }
  const doubled=String.raw`$\\angle A=30^\\circ$，$\\because AB$`;
  assert.equal(normalizeStudioMathEscapes(doubled),String.raw`$\angle A=30^\circ$，$\because AB$`);
  assert.equal(normalizeStudioMathEscapes('$\begin{cases}x=1\\\\y=2\\end{cases}$'),String.raw`$\begin{cases}x=1\\y=2\end{cases}$`);
  assert.equal(normalizeStudioMathEscapes('$\\\\\\bigodot O\\\\$'),String.raw`$\bigodot O$`,'repeated command slashes and a trailing slash are repaired');
  for(const intact of [String.raw`$\begin{cases}x=1\\y=2\end{cases}$`,String.raw`$\begin{aligned}a&=1\\beta&=2\end{aligned}$`,String.raw`$\text{C:\\folder}$`,'正文\\\\angle']){
    assert.equal(normalizeStudioMathEscapes(intact),intact,'environment row separators, text and prose are not decoded');
  }
  assert.equal(normalizeStudioMathEscapes('$\bunknown$'),'$\bunknown$','unknown damage stays visible');
});
