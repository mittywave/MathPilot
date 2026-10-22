import {before,after} from 'node:test';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {loadSource} from './load-source.mjs';
import {SUPPORTED_MATH_SYMBOLS,SUPPORTED_MATH_ENVIRONMENTS} from '../lib/math-capabilities.mjs';
import {mathContractDraft} from './fixtures/math-contract.mjs';
const nativeFetch=globalThis.fetch;
before(()=>{globalThis.fetch=(url,...args)=>url==='/standard-math-paper.docx'?Promise.resolve(new Response(readFileSync('public/standard-math-paper.docx'))):nativeFetch(url,...args);});
after(()=>{globalThis.fetch=nativeFetch;});
const {mathOmml}=await loadSource('lib/math-omml.ts');
const {studioMathIssues,studioWordEquationXml,STUDIO_MATH_SIZE}=await loadSource('lib/studio-math-layout.ts');
const {buildStudioWord,assertStudioMathSupported}=await loadSource('lib/answer-studio-export.ts');
const {parseMathGrid,parseArrayColumns}=await loadSource('lib/math-grid.ts');
const read=async blob=>(await JSZip.loadAsync(await blob.arrayBuffer())).file('word/document.xml').async('string');
test('every registered symbol compiles natively, with no command-name fallback',()=>{
  for(const name of Object.keys(SUPPORTED_MATH_SYMBOLS))assert.doesNotThrow(()=>mathOmml('\\'+name),name);
});
test('every registered environment has a minimal native representation',()=>{
  for(const env of SUPPORTED_MATH_ENVIRONMENTS){
    const source=`\\begin{${env}}${env==='array'?'{lr}':''}1&2\\\\3&4\\end{${env}}`;
    assert.doesNotThrow(()=>mathOmml(source),env);
  }
});
test('balanced grids preserve nested cases, matrices, escaped delimiters and text arguments',()=>{
  const source=String.raw`\begin{bmatrix}\begin{matrix}1&2\\3&4\end{matrix}&\text{a\&b}\\0&\begin{cases}x=1\\y=2\end{cases}\end{bmatrix}`;
  const xml=mathOmml(source);
  assert.equal((xml.match(/<m:m>/g)||[]).length,2);
  assert.equal((xml.match(/<m:eqArr>/g)||[]).length,1);
  assert.equal(parseMathGrid(String.raw`{x&y}&z\\a&b`).rows.length,2);
  assert.equal(parseMathGrid(String.raw`\text{a\&b}&c`).rows[0].length,2);
});
test('array columns and whitespace are explicit; unsupported material is not discarded',()=>{
  assert.deepEqual(parseArrayColumns(String.raw`l@{\quad}cr`).map(c=>c.align),['left','center','right']);
  for(const spec of ['l|r','p{2cm}','*{2}{c}',String.raw`l@{+}r`])assert.throws(()=>parseArrayColumns(spec));
});
test('malformed and excessive grids fail closed before export',()=>{
  for(const text of [String.raw`\begin{matrix}1\end{cases}`,String.raw`\begin{array}{r}1&2\end{array}`,String.raw`\begin{matrix}1\\[3pt]2\end{matrix}`,String.raw`x\\y`, '{'.repeat(70)+'1'+'}'.repeat(70)])assert.throws(()=>mathOmml(text));
});
test('all inline and display math runs share the reference body size, independent of depth',()=>{
  for(const display of [false,true])for(const expression of ['x_1',String.raw`\frac{\frac12}{\sqrt{x^2}}`]){
    const xml=studioWordEquationXml(expression,display);
    const sizes=[...xml.matchAll(/<w:sz w:val="(\d+)"/g)].map(m=>Number(m[1]));
    assert.ok(sizes.length);assert.ok(sizes.every(size=>size===STUDIO_MATH_SIZE));
  }
});
test('formal fixture has native matrices, fractions and ruled editable tables, no placeholders',async()=>{
  const draft=mathContractDraft(),before=structuredClone(draft);
  for(const q of draft.questions)assert.deepEqual(studioMathIssues(q.analysis),[]);
  const xml=await read(await buildStudioWord(draft,'text',{transcription:true}));
  assert.equal((xml.match(/<w:tbl>/g)||[]).length,2);
  assert.match(xml,/<w:bottom w:val="single"/);
  assert.match(xml,/<w:jc w:val="right"/);
  // Cell paragraph alignment, not global display-math justification, owns the grid.
  assert.match(xml,/<w:jc w:val="center"/);
  assert.match(xml,/<m:m>/);assert.match(xml,/<m:f>/);
  assert.doesNotMatch(xml,/STUDIO_MATH_|<w:drawing|<m:phant>|\\hline/);
  assert.deepEqual(draft,before);
});
test('unsupported native ruled-array contexts are blocked instead of silently losing rules',()=>{
  const ruled=String.raw`\begin{array}{r}12\\\hline3\end{array}`;
  assert.doesNotThrow(()=>assertStudioMathSupported('$$'+ruled+'$$'));
  assert.throws(()=>assertStudioMathSupported('$x='+ruled+'$'));
  assert.throws(()=>assertStudioMathSupported('$$'+ruled+'$$',false));
});
test('formal export identifies question and field; fallback requires explicit review mode',async()=>{
  const draft=mathContractDraft();draft.questions[0].analysis=String.raw`$\unknown{x}$`;
  await assert.rejects(()=>buildStudioWord(draft,'text',{transcription:true}),/1.*unknown/s);
  await assert.rejects(()=>buildStudioWord(draft,'text',{transcription:true,bestEffort:true}),/review copy/);
  const xml=await read(await buildStudioWord(draft,'text',{transcription:true,reviewCopy:true,bestEffort:true}));
  assert.match(xml,/\u5f85\u6821\u5bf9\u6837\u5f20/);assert.match(xml,/unknown/);assert.match(xml,/\u516c\u5f0f\u5f85\u6838\u5bf9/);
});

test('a leading relation in an aligned cell is a literal editable math run, not a missing operand',()=>{
  const xml=mathOmml(String.raw`\begin{aligned}x&=\frac12\\y&\leq2\end{aligned}`);
  assert.equal((xml.match(/<m:nor\/>/g)||[]).length,4); // 2 relations + 2 inter-column spaces
  assert.match(xml,/<m:t[^>]*>=<\/m:t>/);
});

test('a relation later in an equation does not turn its leading variable into normal text',()=>{
  assert.doesNotMatch(mathOmml('x=1').match(/^<m:r>[\s\S]*?<\/m:r>/)[0],/<m:nor/);
});
