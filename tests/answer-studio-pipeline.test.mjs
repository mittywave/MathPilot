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
  await build({entryPoints:['lib/answer-studio-pipeline.ts','lib/answer-studio-layout.ts','lib/answer-studio-normalize.ts','lib/answer-studio-drawings.ts'],outdir:dir,bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},logLevel:'silent'});
  return {...require(join(dir,'answer-studio-pipeline.cjs')),...require(join(dir,'answer-studio-layout.cjs')),...require(join(dir,'answer-studio-normalize.cjs')),...require(join(dir,'answer-studio-drawings.cjs'))};
}
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
  for(const file of ['lib/answer-studio-images.ts','lib/file-import.ts','app/tools/typeset/PdfPreview.tsx']){
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
