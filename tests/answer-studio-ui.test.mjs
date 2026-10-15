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
function render({Page,seed},{saved=draft,busy=false,notice='',failed=false,downloads=[]}={}){
  // useState order in AnswerStudioPage: auth, input fields, lifecycle, result,
  // transcription-warning preference, then text concurrency.
  seed([{id:'local',local:true},true,'answers','界面验证',[],[],busy,notice,failed,saved,downloads,'full',true,4]);
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
    assert.doesNotMatch(html,/102|个提示|当前记录|已生成|本地项目备份|生成备份|恢复 JSON|application\/json|三种版本共用/);
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
});
