import {before,after} from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
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

test('all Studio Word modes preserve repaired math and the same reference paragraph framework',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'studio-word-repair-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const output=join(directory,'export.cjs');
  await build({entryPoints:['lib/answer-studio-export.ts'],outfile:output,bundle:true,platform:'node',format:'cjs',packages:'external',alias:{docx:require.resolve('docx'),jszip:require.resolve('jszip')},external:[require.resolve('docx'),require.resolve('jszip')],logLevel:'silent'});
  const {buildStudioWord,studioAnswerParagraphs}=require(output);
  const sourceBox={x:10,y:10,width:980,height:800};
  const analysis=[
    '\u6545 $f(x)$ \u4e3a $\\mathbb{R}$ \u4e0a\u7684\u589e\u51fd\u6570',
    '\u7531\u2460,\u2461$ \\Rightarrow \\begin{cases}a_1=4\\\\d=2\\end{cases}$$$',
    String.raw`\begin{cases}x=-2\\y=2\end{cases}\\Rightarrow(-2,2)`,
    '$$\n'+String.raw`\frac{\frac12-k_{CD}}{1+\frac12 k_{CD}}=\frac43`+'\n$$',
    '$k_{CD}=-\\frac12$',
  ].join('\n');
  const q={id:'q1',lesson:'Regression',section:'Example',number:'1',stem:'$x\\in\\mathbb{R}$',analysis,questionSources:[],answerOnly:true,answerIds:['a1'],diagrams:[],tables:[],warnings:[],resolutions:{},reviewed:false,drawingsChecked:true,drawingsIncludeQuestionFigures:false,drawingDisposition:'none'};
  const draft={version:1,inputMode:'answers',title:'Regression',updatedAt:0,pages:[{id:'p1',role:'answer',name:'sample.png',page:1,image:'data:image/png;base64,AA==',hash:'h',selected:true,processed:true}],questions:[q],answers:[{id:'a1',lesson:q.lesson,section:q.section,number:q.number,stem:q.stem,analysis,source:{pageId:'p1',box:sourceBox},diagramBoxes:[],warnings:[],continuation:false}]};
  const original=structuredClone(draft);
  const paragraphs=studioAnswerParagraphs(analysis);
  assert.ok(paragraphs.some(p=>p.text.startsWith('$$\n')&&p.text.endsWith('\n$$')),'multiline equation remains one logical paragraph');
  for(const mode of ['full','text','steps'])for(const includeTranscriptionWarnings of [true,false]) {
    const blob=await buildStudioWord(draft,mode,{transcription:true,bestEffort:true,reviewCopy:true,includeTranscriptionWarnings});
    const zip=await JSZip.loadAsync(await blob.arrayBuffer());
    const xml=await zip.file('word/document.xml').async('string');
    assert.match(xml,/\u211d/);
    assert.match(xml,/<m:oMath>/);assert.doesNotMatch(xml,/<m:oMathPara>/);
    assert.match(xml,/w:line="360"/);
    assert.match(xml,/<w:sz w:val="30"\/>/);
    assert.match(xml,/<w:sz w:val="21"\/>/);
    assert.doesNotMatch(xml,/mathbb|Rightarrow|\$\$\$|\u516c\u5f0f\u5f85\u6838\u5bf9|<undefined>/);
    assert.ok((xml.match(/<m:sSub>/g)||[]).length>=3);
    assert.deepEqual(draft,original,'export and repairs must not mutate the caller draft');
  }
});
