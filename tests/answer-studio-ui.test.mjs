import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require=createRequire(import.meta.url);
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'studio-ui-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  // Seed component state, but render the actual page JSX. No browser storage
  // or AI services are touched by these presentation-only regression cases.
  await build({
    stdin:{contents:"export {default as Page} from './app/tools/answer-studio/page'; export {seed} from 'studio-test-hooks';",resolveDir:process.cwd()},
    bundle:true,format:'cjs',platform:'node',jsx:'automatic',outfile:join(dir,'ui.cjs'),loader:{'.css':'empty'},logLevel:'silent',
    plugins:[{name:'page-hook-seeds',setup(build){
      build.onResolve({filter:/^studio-test-hooks$/},()=>({path:'hooks',namespace:'test'}));
      // Shared headers use the renderer's React; only this page receives seeded hooks.
      build.onResolve({filter:/^react(?:\/.*)?$/},args=>args.path==='react'&&args.importer.endsWith('/tools/answer-studio/page.tsx')?{path:'hooks',namespace:'test'}:{path:require.resolve(args.path),external:true});
      build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'let values=[]; export function seed(state){values=[...state]} export function useState(){if(!values.length)throw Error("Missing page state seed"); return [values.shift(),()=>{}]} export function useEffect(){} export function useRef(value){return {current:value}} export function useCallback(callback){return callback}',loader:'js'}));
    }}],
  });
  return require(join(dir,'ui.cjs'));
}
const draft={version:1,inputMode:'answers',title:'界面验证',pages:[],answers:[],questions:[{id:'q',stem:'原题',analysis:'解析',answerIds:[],diagrams:[],tables:[],warnings:Array.from({length:102},(_,i)=>`原有提示${i}`)}]};
function render({Page,seed},{saved=draft,busy=false,notice='',failed=false,downloads=[],jobs=[],openJobId='',cancellingJobId='',questionFiles=[],answerFiles=[]}={}){
  // useState order in AnswerStudioPage: auth, title and files, lifecycle, result,
  // transcription-warning preference, text concurrency, then server jobs.
  seed([{id:'local',local:true},true,'界面验证',questionFiles,answerFiles,busy,notice,failed,saved,downloads,'full',true,4,jobs,openJobId,cancellingJobId]);
  return renderToStaticMarkup(createElement(Page));
}
test('ready and downloaded results hide issue statistics and backup controls without changing the draft',async t=>{
  const ui=await fixture(t),original=structuredClone(draft);
  for(const downloads of [[],[{label:'下载 Word',name:'界面验证.docx',url:'blob:local-result'}]]){
    const html=render(ui,{downloads,notice:'完整解题版已生成：1 题。发现 102 个提示，已写入 Word。'});
    assert.match(html,/转录结果/);assert.match(html.replace(/<[^>]+>/g,''),/1道题已识别/);
    assert.equal((html.match(/name="studio-output"/g)||[]).length,3);
    assert.equal(html.includes('生成 Word'),downloads.length===0);
    assert.equal(html.includes('下载完整解题版'),downloads.length>0);
    // Only the page body: the brand wordmark's SVG coordinates can contain these digits.
    assert.doesNotMatch(html.slice(html.indexOf('<main')),/102|个提示|当前记录|已生成|本地项目备份|生成备份|恢复 JSON|application\/json|三种版本共用/);
  }
  assert.deepEqual(draft,original,'hiding UI never removes original annotations');
});
test('processing and actionable errors remain visible, while idle upload has no repeated notice panels',async t=>{
  const ui=await fixture(t);
  const busy=render(ui,{busy:true,notice:'正在处理配图 2/10 题…'});
  assert.match(busy,/role="status"/);assert.match(busy,/正在处理配图 2\/10 题/);assert.match(busy,/正在生成/);
  const failure=render(ui,{failed:true,notice:'登录状态读取失败'});
  assert.match(failure,/studio-error/);assert.match(failure,/登录状态读取失败/);
  const idle=render(ui,{saved:null});
  assert.match(idle,/开始转录/);assert.doesNotMatch(idle,/role="status"|本地项目备份|个提示/);
  const job={title:'第一讲',pageCount:3,processedCount:1,questionCount:0,progress:'',error:'',createdAt:0,updatedAt:0};
  const list=render(ui,{saved:null,jobs:[{...job,id:'a',status:'running'},{...job,id:'b',status:'done',questionCount:5},{...job,id:'c',status:'failed',error:'识别服务异常'},{...job,id:'d',status:'running',stalled:true}]});
  assert.match(list,/转录任务/);assert.match(list,/转录中 1\/3 页/);assert.match(list,/已完成 · 5 题/);assert.match(list,/识别服务异常/);assert.match(list,/已中断/);assert.match(list,/点继续从断点接着转录/);
  assert.match(list,/>打开</);assert.equal((list.match(/>继续</g)||[]).length,2,'failed and stalled jobs continue');
  assert.equal((list.match(/aria-label="这个转录任务的操作"/g)||[]).length,3,'a live running job cannot be deleted');
});
test('queued and running rows end with cancel; cancelled rows retain continue and delete',async t=>{
  const ui=await fixture(t);
  const base={title:'取消验证',stalled:false,pageCount:3,processedCount:1,questionCount:1,progress:'',error:'',createdAt:0,updatedAt:0};
  const jobs=[{...base,id:'queued',status:'queued'},{...base,id:'running',status:'running'},{...base,id:'cancelled',status:'failed',progress:'已取消'},{...base,id:'done',status:'done'}];
  const html=render(ui,{saved:null,jobs});
  assert.equal((html.match(/>取消转录<\/button><\/td>/g)||[]).length,2,'cancel is the rightmost row action');
  assert.match(html,/class="job-state" title="已取消">已取消/);
  assert.equal((html.match(/>继续<\/button>/g)||[]).length,1);
  const pending=render(ui,{saved:null,jobs,cancellingJobId:'running'});
  assert.match(pending,/<button type="button" disabled="">取消中…<\/button>/);
  assert.match(pending,/<button type="button" disabled="">取消转录<\/button>/);
});
test('queued and running rows show a pulsing dot; stalled, failed and finished rows do not',async t=>{
  const ui=await fixture(t);
  const base={title:'进行中',stalled:false,pageCount:3,processedCount:1,questionCount:1,progress:'',error:'',createdAt:0,updatedAt:0};
  const jobs=[{...base,id:'queued',status:'queued'},{...base,id:'running',status:'running'},{...base,id:'stalled',status:'running',stalled:true},{...base,id:'failed',status:'failed',error:'超时'},{...base,id:'done',status:'done'}];
  const html=render(ui,{saved:null,jobs});
  assert.equal((html.match(/class="job-state live"/g)||[]).length,2);
  assert.match(html,/class="job-state danger-text"[^>]*>已中断/);
});
test('the uploaded files decide the mode, and a question paper offers only question versions',async t=>{
  const ui=await fixture(t),file=name=>({name});
  const empty=render(ui,{saved:null});
  assert.match(empty,/粘贴或拖入原题/);assert.match(empty,/粘贴或拖入答案/);assert.doesNotMatch(empty,/radiogroup|只有答案材料|转录方式/);
  assert.match(empty.replace(/<[^>]+>/g,''),/还差：资料名称|还差：原题或答案/);
  for(const [questionFiles,answerFiles,mode] of [[[file('卷.pdf')],[],'只有原题，转成可编辑的题目 Word'],[[],[file('答.pdf')],'只有答案'],[[file('卷.pdf')],[file('答.pdf')],'原题和答案']]){
    const html=render(ui,{saved:null,questionFiles,answerFiles});
    assert.match(html,new RegExp('转录方式：'+mode));assert.doesNotMatch(html,/还差：/);
  }
  const paper=render(ui,{saved:{...draft,inputMode:'questions'}});
  assert.equal((paper.match(/name="studio-output"/g)||[]).length,2);
  assert.match(paper,/题目版（无图）/);assert.doesNotMatch(paper,/仅解题步骤版|完整解题版/);
});
