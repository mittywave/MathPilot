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

test('Word export can include or omit transcription problem hints without changing content',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mitty-warning-toggle-'));
  try {
    const output=join(dir,'export.cjs');
    await build({entryPoints:['lib/answer-studio-export.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',alias:{docx:require.resolve('docx'),jszip:require.resolve('jszip')},external:[require.resolve('docx'),require.resolve('jszip')],outfile:output,logLevel:'silent'});
    const {buildStudioWord}=require(output);
    const question={
      id:'q',lesson:'第一讲',section:'例题精练',number:'1',stem:'原题 $x=1$',analysis:'解：$x=1$',
      questionSources:[],answerIds:['a'],diagrams:[],warnings:['原文此处较模糊，请人工核对'],resolutions:{},reviewed:true,
    };
    const draft={version:1,title:'提示开关测试',inputMode:'paired',pages:[],questions:[question],answers:[{id:'a'}]};

    const withHints=await JSZip.loadAsync(await (await buildStudioWord(draft,'text',{transcription:true,bestEffort:true,reviewCopy:true,includeTranscriptionWarnings:true})).arrayBuffer());
    const withoutHints=await JSZip.loadAsync(await (await buildStudioWord(draft,'text',{transcription:true,bestEffort:true,reviewCopy:true,includeTranscriptionWarnings:false})).arrayBuffer());
    const withXml=await withHints.file('word/document.xml').async('string');
    const withoutXml=await withoutHints.file('word/document.xml').async('string');

    assert.match(withXml,/转录提示：/);
    assert.match(withXml,/原文此处较模糊，请人工核对/);
    assert.doesNotMatch(withoutXml,/转录提示：|格式问题：/);
    for(const expected of ['原题','解：']) {
      assert.match(withXml,new RegExp(expected));
      assert.match(withoutXml,new RegExp(expected));
    }
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});
